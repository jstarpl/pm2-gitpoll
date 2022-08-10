/**
 * Copyright 2016 vmarchaud. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

var pmx = require('pmx');
var pm2 = require('pm2');
var spawn = require('child_process').spawn;
var async = require('async');
var vizion = require('vizion');
const { setInterval } = require('timers');

const POLL_INTERVAL = 10 * 60 * 1000;

/**
 * Init pmx module
 */
pmx.initModule({}, function (err, conf) {
  pm2.connect(function (err2) {
    if (err || err2) {
      console.error(err || err2);
      return process.exit(1);
    }
    // init the worker only if we can connect to pm2
    new Worker(conf).start();
  });
});

/**
 * Constructor of our worker
 *
 * @param {object} opts The options
 * @returns {Worker} The instance of our worker
 * @constructor
 */
var Worker = function (opts) {
  if (!(this instanceof Worker)) {
    return new Worker(opts);
  }

  this.opts = opts;
  this.pollInterval = opts.pollInterval || POLL_INTERVAL;
  this.apps = opts.apps;

  if (typeof (this.apps) !== 'object') {
    this.apps = JSON.parse(this.apps);
  }

  return this;
};

/**
 * Main function for checking all repositories
 *
 * @param req The Request
 * @param res The Response
 * @private
 */
Worker.prototype._fetchRepositories = function () {
  var self = this;

  const allApps = Object.entries(self.apps)

  for (const [targetName, targetApp] of allApps) {
    updateCWD(targetApp, () => {
      vizion.isUpToDate({
        folder: targetApp.cwd,
      }, (err, meta) => {
        if (err) {
          console.error('[%s] Could not fetch from remote %s: %s', new Date().toISOString(), targetName, err);
          return;
        }

        if (!meta.is_up_to_date) {
          self.updateApp(targetName);
        }
      })
    })
  }
};

/**
 * Main function of the module
 *
 * @param targetName The name of the app to be updated
 */
Worker.prototype.updateApp = function (targetName) {
  var targetApp = this.apps[targetName];
  if (!targetApp) return;

  var error = this.checkRequest(targetApp, req);
  if (error) {
    console.log(error);
    return;
  }

  console.log('[%s] Found an update for app %s', new Date().toISOString(), targetName);

  var execOptions = {
    cwd: targetApp.cwd,
    env: process.env,
    shell: true
  };
  var phases = {
    resolveCWD: function resolveCWD(cb) {
      updateCWD(targetApp, cb);
    },
    pullTheApplication: function pullTheApplication(cb) {
      vizion.update({
        folder: targetApp.cwd
      }, logCallback(cb, '[%s] Successfuly pulled application %s', new Date().toISOString(), targetName));
    },
    preHook: function preHook(cb) {
      if (!targetApp.prehook) return cb();

      spawnAsExec(targetApp.prehook, execOptions,
          logCallback(cb, '[%s] Prehook command has been successfuly executed for app %s', new Date().toISOString(), targetName));
    },
    reloadApplication: function reloadApplication(cb) {
      if (targetApp.nopm2) return cb();

      pm2.gracefulReload(targetName,
	    logCallback(cb, '[%s] Successfuly reloaded application %s', new Date().toISOString(), targetName));
    },
    postHook: function postHook(cb) {
      if (!targetApp.posthook) return cb();

      // execute the actual command in the cwd of the application
      spawnAsExec(targetApp.posthook, execOptions,
          logCallback(cb, '[%s] Posthook command has been successfuly executed for app %s', new Date().toISOString(), targetName));
    }
  };
  async.series(Object.keys(phases).map(function(k){ return phases[k]; }),
    function (err, results) {
      if (err) {
        console.log('[%s] An error has occuring while processing app %s', new Date().toISOString(), targetName);
        if (targetApp.errorhook) spawnAsExec(targetApp.errorhook, execOptions,
          logCallback(() => {}, '[%s] Errorhook command has been successfuly executed for app %s', new Date().toISOString(), targetName));
        console.error(err);
      }
    });
};

/**
 * Lets start our polling
 */
Worker.prototype.start = function () {
  var self = this;
  setInterval(() => {
    self._fetchRepositories();
  }, self.pollInterval);
  // check if up-to-date on start
  self._fetchRepositories();
};

/**
 * Executes the callback, but in case of success shows a message.
 * Also accepts extra arguments to pass to console.log.
 *
 * Example:
 * logCallback(next, '% worked perfect', appName)
 *
 * @param {Function} cb The callback to be called
 * @param {string} message The message to show if success
 * @returns {Function} The callback wrapped
 */
function logCallback(cb, message) {
  var wrappedArgs = Array.prototype.slice.call(arguments);
  return function (err, data) {
    if (err) return cb(err);

    wrappedArgs.shift();
    console.log.apply(console, wrappedArgs);
    cb();
  }
}

/**
 * Wraps the node spawn function to work as exec (line, options, callback).
 * This avoid the maxBuffer issue, as no buffer will be stored.
 *
 * @param {string} command The line to execute
 * @param {object} options The options to pass to spawn
 * @param {function} cb The callback, called with error as first argument
 */
function spawnAsExec(command, options, cb) {
  var child = spawn('eval', [command], options);
  child.on('close', cb);
}

function updateCWD(targetApp, cb) {
  // if cwd is provided, we expect that it isnt a pm2 app
  if (targetApp.cwd) return cb();

  // try to get the cwd to execute it correctly
  pm2.describe(targetName, function (err, apps) {
    if (err || !apps || apps.length === 0) return cb(err || new Error('Application not found'));

    // execute the actual command in the cwd of the application
    targetApp.cwd = apps[0].pm_cwd ? apps[0].pm_cwd : apps[0].pm2_env.pm_cwd;
    return cb();
  });
}