"use strict";

var path            = require("path")
var config          = require("../config")
var logger          = require("./logger")
var deasync         = require("deasync")
var extend          = require("extend")
let denodeify       = require("denodeify")
let routes          = require("./routes")
let utils           = require("./utils")

let fs              = utils.fs

var RENDER_ROOT_STR = "@"

const pathjoin = path.join;

module.exports = class Renderer {
	constructor(dirname, db, hbs) {
		this.TEMPLATE_DIR = pathjoin(dirname, config.paths.templates)
		this.RENDER_DIR = pathjoin(dirname, config.paths.render);

		this.db = db;
		this.templates = {};
		this.hbs = hbs;

		this.reload();
	}

	// Express middleware handler
	handle(req, res, next) {
		logger.info(`Querying renderer for ${req.path}`);
		let route = routes.find((route) => route.path.test(req.path));

		if (req.method !== "GET" || route === undefined) {
			logger.warn(`Exiting renderer`);
			next();
			return;
		}

		this.renderPath(req.path, res, req.user);
	}

	// Clears the render cache, reloads all templates, and prerenders
	reload() {
		this.clearCache().then(this.compileAll.bind(this)).then(this.prerender.bind(this)).catch(this.crash);
	}

	// Compiles all templates in the template directory and caches them locally
	compileAll() {
		logger.info("Compiling all");
		return fs.readdir(this.TEMPLATE_DIR)
			.then((files) =>
				Promise.all(files.map((file) => fs.readFile(pathjoin(this.TEMPLATE_DIR, file)).then((contents) =>
					({file, contents: contents.toString()})))))
			.then((files) =>
				files.forEach(({file, contents}) => {
					this.templates[file] = this.hbs.compile(contents, { preventIndent: true });
					this.hbs.registerPartial(file, contents);
				}))
			.catch(this.crash);
	}

	// Clears the cache of rendered pages
	clearCache() {
		return fs.mkdir(this.RENDER_DIR) // in case the dir doesn't exist, create it to prevent failure
			.catch(() => undefined) // if it existed, catch the error
			.then(() => fs.readdir(this.RENDER_DIR))
			.then((files) => Promise.all(files.map((file) => fs.unlink(pathjoin(this.RENDER_DIR, file)))));
	}

	// Prerenders all pages specified in routes
	prerender() {
		return Promise.all(routes.filter((route) => route.prerender !== undefined)
				.map((route) => reduceToPromise(route.prerender, this.db)))
			.then((paths) => paths.reduce((a, b) => a.concat(b), []))
			.then((paths) => paths.forEach((path) => this.renderPath(path))); // todo: fix scoping?
	}

	// Renders a single path, pulling from the cache if available, and storing in the cache if allowed
	renderPath(path, res, user) {
		logger.info(`Rendering ${path}`);
		let cachePath = this.getCachePath(path);

		fs.readFile(cachePath)
			.then((content) => { // the page was cached
				let route = routes.find((route) => route.path.test(path));

				if (route === undefined) {
					logger.error(`Cache polluted with path ${path}`);
					this.fourohfour(undefined, res, undefined);
					return;
				}

				logger.ok(`Pulled ${path} from cache`);
				let mime = route.mime || "text/html"
				if (res !== undefined) {
					res.type(mime);
					res.send(content);
				}
			})
			.catch(() => { // it's not cached, so we'll render it
				let route = routes.find((route) => route.path.test(path));

				if (route === undefined) {
					logger.error(`No route found for ${path}`);
					this.fourohfour(undefined, res, undefined);
					return;
				}

				let params = route.path.exec(path);
				let options = (route.options || (() => ({ render: {}, serving: {} })))(params);

				let mime = route.mime || "text/html"

				return reduceToPromise(route.context || {}, params, this.db)
					.then((context) => {
						logger.info(`Building ${path}`);
						context.user = user;
						let content = this.renderPage(route.page, context);

						return content;
					})
					.then((content) => { // the render succeeded
						if (res !== undefined) {
							logger.ok(`Sending ${path}`);
							res.type(mime);
							res.send(content);
						}

						if (route.cache) {
							logger.ok(`Caching ${path}`);
							return fs.writeFile(cachePath, content)
								.then(() => content);
						}
					})

			})
			.catch(this.crash);
	}

	// Renders a single page with handlebars
	renderPage(page, options) {
		return this.templates[page](options);
	}

	// Debugging function if something goes wrong
	crash(error) {
		logger.error(error.stack);
	}

	// Converts a path to its location in the cache
	getCachePath(path) {
		return pathjoin(this.RENDER_DIR, "@" + path.replace(/\/$/, "").replace(/\//g, "."));
	}

	// Sends a 404
	fourohfour(req, res, next) {
		if (res !== undefined) {
			res.status(404).type("text/html").sendFile(this.getCachePath("/404"));
		} else if (next !== undefined) {
			next();
		}
	}
}

function reduceToPromise(val, ...args) {
	while (typeof val == "function") {
		val = val(...args);
	}

	return Promise.resolve(val);
}

var getTags = function(db) {
	return deasync(function(cb) {
		db.posts.distinct("tags", {}, function(err, data) {
			cb(err, data)
		})
	})()
}

var getPosts = function(db, all) {
	return deasync(function(cb) {
		var query = {}
		if (!all) query.visible = true
		db.posts.distinct("guid", query, function(err, data) {
			cb(err, data)
		})
	})()
}
