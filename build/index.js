"use strict";

var _url = require("url");

var _utils = require("./utils");

var _nodeFetch = _interopRequireDefault(require("node-fetch"));

var _cheerio = _interopRequireDefault(require("cheerio"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class Crawler {
  constructor(options = {}) {
    this._options = Object.assign({}, {
      maxRequest: -1,
      skipStrictDuplicates: true,
      sameOrigin: true,
      maxDepth: 3,
      parallel: 5,
      debugging: false,
      retryCount: 2,
      retryTimeout: 5000,
      timeBetweenRequest: 0
    }, options);
    if (this._options.timeBetweenRequest > 0) this._options.parallel = 1;
    this.hostdomain = '';
    this.linksToCrawl = new Map();
    this.linksCrawled = new Map();
    this._actions = {
      preRequest: this._options.preRequest || (x => x),
      onSuccess: this._options.onSuccess || null,
      evaluatePage: this._options.evaluatePage || null,
      onRedirection: this._options.onRedirection || (({
        previousUrl
      }) => previousUrl)
    };
  }

  fetch(...args) {
    let retries = 0;

    const _retry = () => Promise.race([(0, _nodeFetch.default)(...args), new Promise((resolve, reject) => setTimeout(() => reject(new Error('TIMEOUT')), this._options.retryTimeout))]).catch(error => {
      if (retries < this._options.retryCount) {
        retries++;
        return _retry(...args);
      } else return Promise.reject(error);
    });

    return _retry();
  }
  /**
   * Init the app.
   * Begin with the first link, and start the pulling
   * @return {Promise<pending>}
   */


  async init() {
    try {
      if (!(0, _utils.isUrl)(this._options.url)) throw new Error();
      const link = new _url.URL(this._options.url);
      this.hostdomain = link.origin;
      if (!this.hostdomain) throw new Error();
    } catch (error) {
      console.error(error);
      throw new Error('URL provided (' + this._options.url + ') is not valid');
    }

    const sanitizedUrl = await this.shouldRequest(this._options.url);
    if (!sanitizedUrl) return;
    this.linksCrawled.set(sanitizedUrl);
    await this.pull(sanitizedUrl, 1);
    if (this.linksToCrawl.size > 0) await this.crawl();
  }
  /**
   * Get all links from the page.
   * @param {Cheerio} $
   * @param {String} actualHref
   * @return {Promise<Array<String>}
   */


  collectAnchors($, actualHref) {
    let linksCollected = [];

    try {
      linksCollected = $('a').map((i, e) => (0, _utils.relativePath)($(e).attr('href') || '', actualHref)) // Cheerio map method
      .filter((i, href) => (0, _utils.isUrl)(href)) // Cheerio filter method
      .map((i, href) => {
        const url = new _url.URL(href);
        url.hash = '';
        return url.href;
      }).get(); // Cheerio get method to transform as an array
    } catch (error) {
      console.error(`Something wrong happened with this url: ${actualHref}`);
      console.error(error);
    }

    return [...new Set(linksCollected)]; // Avoid duplication
  }
  /**
   * Check if link can be crawled (Same origin ? Already collected ? preRequest !false ?).
   * @param {String} link
   * @return {Promise<Boolean>}
   */


  async skipRequest(link) {
    const allowOrigin = this.checkSameOrigin(link);
    if (!allowOrigin) return true;
    const urlSanitazed = await this.shouldRequest(link);
    if (!urlSanitazed) return true;
    if (this._options.skipStrictDuplicates && this.linkAlreadyCollected(urlSanitazed)) return true;
    return false;
  }
  /**
   * If preRequest is provided by the user, get new link or false.
   * @param {String} link
   * @return {Promise<String || Boolean>}
   */


  async shouldRequest(link) {
    if (this._actions.preRequest instanceof Function) {
      try {
        const preRequest = await this._actions.preRequest(link);
        if (preRequest === false && this._options.debugging) console.info(`\x1b[33m Ignoring ${link} \x1b[m`);
        if (typeof preRequest === 'string' || preRequest === false) return preRequest;
        throw new Error('preRequest function must return a String or False');
      } catch (error) {
        console.error('Please try/catch your preRequest function');
        console.error(error.message);
      }
    }

    return link;
  }
  /**
   * Check if link has the same origin as the host link.
   * @param {String} url
   * @return {Boolean}
   */


  checkSameOrigin(url) {
    if (this._options.sameOrigin) return new _url.URL(url).origin === this.hostdomain;
    return true;
  }
  /**
   * If evaluatePage is provided by the user, await for it.
   * @param {Cheerio} $
   * @return {Promise}
   */


  async evaluate($) {
    let result = null;

    if (this._actions.evaluatePage && this._actions.evaluatePage instanceof Function) {
      try {
        result = await this._actions.evaluatePage($);
      } catch (error) {
        console.error(error);
      }
    }

    return result;
  }
  /**
   * Add links collected to queue.
   * @param {Array<String>} urlCollected
   * @param {Number} depth
   * @return {Promise}
   */


  async addToQueue(urlCollected, depth = 0) {
    for (const url of urlCollected) {
      if (depth <= this._options.maxDepth) {
        if (!(await this.skipRequest(url))) {
          const linkEdited = await this.shouldRequest(url);
          this.linksToCrawl.set(linkEdited, depth);
        }
      }
    }
  }
  /**
   * Crawl links from 'linksToCrawl' and wait for having 'canceled' to true.
   * @return {Promise>}
   */


  crawl() {
    return new Promise((resolve, reject) => {
      let canceled = false;
      let currentCrawlers = 0;

      const pullQueue = () => {
        if (canceled) return;

        while (currentCrawlers < this._options.parallel && this.linksToCrawl.size > 0) {
          canceled = !this.checkMaxRequest();

          if (canceled) {
            currentCrawlers === 0 && resolve();
            break;
          }

          currentCrawlers++;
          const currentLink = this.linksToCrawl.keys().next().value;
          const currentDepth = this.linksToCrawl.get(currentLink);
          this.linksToCrawl.delete(currentLink);
          this.linksCrawled.set(currentLink);
          this.pull(currentLink, currentDepth).then(() => {
            currentCrawlers--;
            if (currentCrawlers === 0 && (this.linksToCrawl.size === 0 || canceled)) resolve();else pullQueue();
          }).catch(error => {
            canceled = true;
            reject(error);
          });
        }
      };

      pullQueue();
    });
  }
  /**
   * Pull result and links from a page and add them to the queue.
   * @param {String} link
   * @param {Number} depth
   * @return {Promise<pending>}
   */


  async pull(link, depth) {
    try {
      if (this._options.timeBetweenRequest) await new Promise(resolve => setTimeout(resolve, this._options.timeBetweenRequest));
      this._options.debugging && console.info(`\x1b[1;32m [${this.linksCrawled.size}${this._options.maxRequest !== -1 ? '/' + this._options.maxRequest : ''}] Crawling ${link} ...\x1b[m`);
      const {
        result,
        linksCollected,
        url,
        isError
      } = await this.scrapePage(link);
      if (!isError) await this.scrapeSucceed({
        urlScraped: url,
        result
      });
      await this.addToQueue(linksCollected, depth + 1);
    } catch (error) {
      console.error(error);
    }
  }
  /**
   * Know if a link will be crawled or has already been crawled.
   * @param {String} url
   * @return {Boolean}
   */


  linkAlreadyCollected(url) {
    return this.linksCrawled.has(url) || this.linksToCrawl.has(url);
  }
  /**
   * Know if we have exceeded the number of request max provided in the options.
   * @return {Boolean}
   */


  checkMaxRequest() {
    if (this._options.maxRequest === -1) return true;
    return this.linksCrawled.size < this._options.maxRequest;
  }
  /**
   * If onSuccess action's has been provided, await for it.
   * @param {Object<{urlScraped: string, result: any}>}
   * @return {Promise<pending>}
   */


  async scrapeSucceed({
    urlScraped,
    result
  }) {
    if (this._actions.onSuccess && this._actions.onSuccess instanceof Function) {
      try {
        await this._actions.onSuccess({
          result,
          url: urlScraped
        });
      } catch (error) {
        console.error('Please try/catch your onSuccess function');
      }
    }
  }
  /**
   * Scrap a page, evaluate and get new links to visit.
   * @param {String} url
   * @return {Promise<{linksCollected: array, result: any, url: string}>}
   */


  async scrapePage(url) {
    try {
      const response = await this.fetch(url);

      if (response.redirected) {
        url = await this._options.onRedirection({
          previousUrl: url,
          response
        });
        if (!url) throw new Error();
      }

      const textResponse = await response.text();

      const $ = _cheerio.default.load(textResponse);

      const [result, linksCollected] = await Promise.all([this.evaluate($), this.collectAnchors($, url)]);
      return {
        linksCollected,
        result,
        url
      };
    } catch (error) {
      return {
        linksCollected: [],
        result: null,
        url,
        isError: true
      };
    }
  }
  /**
   * Starting the crawl.
   * @param {{debugging: Boolean, maxRequest: Number, parallel: Number, maxDepth: Number, sameOrigin: Boolean, skipStrictDuplicates: Boolean, retryCount: Number, retryTimeout: Number, timeBetweenRequest: Number }} options Options of the crawler.
   * @return {Promise<{startCrawlingAt: Date, finishCrawlingAt: Date, linksVisited: Number}>}
   */


  static async launch(options) {
    const startCrawlingAt = new Date();
    const crawler = new Crawler(options);
    await crawler.init();
    const finishCrawlingAt = new Date();
    return {
      startCrawlingAt,
      finishCrawlingAt,
      linksVisited: crawler.linksCrawled.size
    };
  }

}

module.exports = Crawler;
//# sourceMappingURL=index.js.map