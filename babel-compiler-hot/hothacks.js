/*
 * This evalutes to true if we're running as a server package (vs a build
 * plugin inside of meteor-tool).
 */
if (process.env.APP_ID) {
  Meteor.settings.public.HOT_PORT = parseInt(process.env.HOT_PORT);
  return;
}

/*
 * The rest of the code in this file only runs as build plugin.
 * CODE BELOW THIS POINT SURVIVES A SERVER RELOAD.
 */

var fs = Npm.require('fs');
var path = Npm.require('path');
var Accelerator = Npm.require('meteor-hotload-accelerator').default;

hot = {
  lastHash: {},
  bundles: {},
  orig: {}
};

var packageJsonPath = path.join(projRoot, 'package.json');
var pkg = JSON.parse(fs.readFileSync(packageJsonPath));
var pkgSettings = pkg['ecmascript-hot'];
var tsSettings, tsPathMatch, tsSourceMatch;
var babelEnvForTesting;

function updateSettings() {
  // transformStateless
  tsSettings = pkgSettings && pkgSettings.transformStateless;
  tsPathMatch = tsSettings && tsSettings.pathMatch
    ? toRegExp(tsSettings.pathMatch) : /\.jsx$/;
  tsSourceMatch = tsSettings && tsSettings.sourceMatch
    ? toRegExp(tsSettings.sourceMatch) : /^import React/m;

  // babelEnvForTesting
  if (pkgSettings && pkgSettings.babelEnvForTesting)
    babelEnvForTesting = pkgSettings.babelEnvForTesting === 'default'
      ? null : pkgSettings.babelEnvForTesting;
  else
    babelEnvForTesting = 'production';

  // use for babel cache hash since babel output depends on these settings
  babelOtherDeps.ecmaHotPkgJson = pkgSettings;
}

updateSettings();

if (pkgSettings) {
  fs.watch(packageJsonPath, function() {
    var oldPkgSettings = pkgSettings;

    packageJsonPath = path.join(projRoot, 'package.json');
    pkg = JSON.parse(fs.readFileSync(packageJsonPath));
    pkgSettings = pkg['ecmascript-hot'];

    if (JSON.stringify(oldPkgSettings) !== JSON.stringify(pkgSettings)) {

      console.log('\n[gadicc:hot] package.json\'s `ecmascript-hot` section '
        + 'was modified, please restart Meteor.');
      process.exit();
      return;

      // FOR THE BELOW CODE TO WORK WE NEED TO GET METEOR TO REBUILD ALL EXISTING
      // FILES, SO UNTIL WE CAN DO THAT, JUST EXIT.

      console.log('\n[gadicc:hot] package.json\'s `ecmascript-hot` section '
        + 'modified, updating...');

      updateSettings();

        // Note, this assumes that that accelerator will
        //   1. not perform any init actions (true in 0.0.2)
        //   2. store this data in a way that will be re-used (true in 0.0.2)
        fork.send({
          type: 'initPayload',
          data: {
            babelrc: babelrc,
            pkgSettings: pkgSettings
          }
        });

    }
  });
}

/*
 * No HMR in production with our current model (but ideally, in the future)
 * nor in test mode (note, no Meteor.isTest in a build plugin; and the test
 * below will only be true inside of a build plugin in test mode.
 */
if (process.env.NODE_ENV === 'production'
    || process.argv[2] === 'test' || process.argv[2] === 'test-packages') {
  var noop = function() {};
  hot.process = noop;
  hot.forFork = noop;
  hot.transformStateless = function(source) { return source; }

  if (babelEnvForTesting)
    process.env.BABEL_ENV = babelEnvForTesting;

  // This also skips loading the Accelereator.
  return;
}

// This only actually happens in devel when reloading this plugin after change
var gdata = global._babelCompilerGlobalData;
if (!gdata) gdata = global._babelCompilerGlobalData = {};

/*
var id = Math.floor(Math.random() * 100);
console.log('loading ' + id);
process.on('exit', function() {
  console.log('exiting ' + id);
});
*/

var DEFAULT_METEOR_PORT = 3000;
var HOT_PORT_INCREMENT = 2;

var portIndex, HOT_PORT = process.env.HOT_PORT
  || (process.env.PORT
    && (parseInt(process.env.PORT) + HOT_PORT_INCREMENT ))
  || (process.env.METEOR_PORT
    && (parseInt(process.env.METEOR_PORT) + HOT_PORT_INCREMENT ));

if (!HOT_PORT) {
  portIndex = process.argv.indexOf('-p');
  if (portIndex === -1)
    portIndex = process.argv.indexOf('--port');
  if (portIndex === -1)
    HOT_PORT = DEFAULT_METEOR_PORT + HOT_PORT_INCREMENT;
  else {
    HOT_PORT = process.argv[portIndex+1].split(':');
    HOT_PORT = parseInt(HOT_PORT[HOT_PORT.length-1]) + HOT_PORT_INCREMENT;
  }
}

// Used above when running a server package (and not a build plugin)
if (!process.env.HOT_PORT)
  process.env.HOT_PORT = HOT_PORT;

function toRegExp(input) {
  if (typeof input === 'string')
    return new RegExp(input);
  else if (Object.prototype.toString.call(input) === '[object Array]')
    return new RegExp(input[0], input[1]);
  else
    throw new Error("Don't know how to interpret pattern", input);
}

hot.transformStateless = function(source, path) {
  if (!(source.match(tsSourceMatch) && path.match(tsPathMatch))) {
    return source;
  }

  // const MyComponent = ({prop1, prop2}) => ();
  // const MyComponent = (props) => ();
  // const MyComponent = (props, context) => ();  TODO context
  source = source.replace(/\nconst ([A-Z][^ ]*) = \((.*?)\) => \(([\s\S]+?)(\n\S+)/g,
    function(match, className, args, code, rest) {
      if (rest !== '\n);')
        return match;
      return '\nclass ' + className + ' extends React.Component {\n' +
        '  render() {\n' +
        (args ? '    const ' + args + ' = this.props;\n' : '') +
        '    return (' + code + ')\n' +
        '  }\n' +
        '}\n';
    });

  // const MyComponent = (prop1, prop2) => { return ( < ... > ) };
  source = source.replace(/\nconst ([A-Z][^ ]*) = \((.*?)\) => \{([\s\S]+?)(\n\S+)/g,
    function(match, className, args, code, rest) {
      if (rest !== '\n};' || !code.match(/return\s+\(\s*\</))
        return match;
      return '\nclass ' + className + ' extends React.Component {\n' +
        '  render() {\n' +
        (args ? '    const ' + args + ' = this.props;\n' : '') +
        '    ' + code + '\n' +
        '  }\n' +
        '}\n';
    });

  return source;
}

/* */

var fork;
if (!gdata.accelId)
  gdata.accelId = 0;

function startFork() {
  fork = gdata.fork = new Accelerator(HOT_PORT, ++gdata.accelId);

  fork.send({
    type: 'initPayload',
    data: {
      babelrc: babelrc,
      pkgSettings: pkgSettings
    }
  });

  fork.on('message', function(msg) {

    if (msg.type === 'closed') {
      // This global is detected by the new instance
      gdata.fork = null;
      return;
    }

    if (msg.type === 'inputFiles') {
      bci.processFilesForTarget(
        msg.inputFiles.map(function(inputFile) { return new FakeFile(inputFile); }),
        true // fake
      );
      return;
    }

    console.log('[gadicc:hot] Build plugin got unknown message: '
      + JSON.stringify(msg));
  });

}

// this only ever happens when upgrading the build plugin (e.g. devel, upgrade)
var waiting = false;
if (gdata.fork) {
  waiting = {};
  gdata.fork.on('message', function(msg) {
    if (msg.type === 'closed') {
      console.log('[gadicc:hot] Switching to new accelerator instance.');
      startFork();

      if (waiting.setCacheDir)
        fork.send({ type: 'setCacheDir', data: waiting.setCacheDir });
      if (waiting.fileData)
        fork.send({ type: 'fileData', data: waiting.fileData });

      waiting = false;
    }
  });
  gdata.fork.send({ type: 'close' });
} else {
  startFork();
}

// If we're exiting, tell the fork to shutdown too
process.on('exit', function() {
  fork.send({ type: 'close' });
});

hot.setCacheDir = function(cacheDir) {
  if (waiting)
    waiting.setCacheDir = cacheDir;
  else
    fork.send({ type: 'setCacheDir', data: cacheDir });
}

// These next two from meteor/tools/static-assets/server/mini-files.js
var convertToOSPath = function (standardPath, partialPath) {
  if (process.platform === "win32") {
    return toDosPath(standardPath, partialPath);
  }

  return standardPath;
};
var toDosPath = function (p, partialPath) {
  if (p[0] === '/' && ! partialPath) {
    if (! /^\/[A-Za-z](\/|$)/.test(p))
      throw new Error("Surprising path: " + p);
    // transform a previously windows path back
    // "/C/something" to "c:/something"
    p = p[1] + ":" + p.slice(2);
  }

  p = p.replace(/\//g, '\\');
  return p;
};

var sentFiles = {}, bci;
hot.forFork = function(inputFiles, instance, fake) {
  var data = {};
  if (fake) return;
  if (!bci) bci = instance;

/*
    if (!hot.lastHash[path]
        // || packageName !== null
        || inputFileArch !== 'web.browser'
        || inputFilePath.match(/^tests\//)
        || inputFilePath.match(/tests?\.jsx?$/)
        || inputFilePath.match(/specs?\.jsx?$/)
        || packageName === 'gadicc:ecmascript-hot' ) {
*/
  inputFiles.forEach(function(inputFile) {
    var file;
    if (inputFile.getArch() === "web.browser") {
      file = convertToOSPath(path.join(
        inputFile._resourceSlot.packageSourceBatch.sourceRoot,
        inputFile.getPathInPackage()
      ));
      if (!sentFiles[file]) {
        sentFiles[file] = true;
        data[file] = {
          packageName: inputFile.getPackageName(),
          pathInPackage: inputFile.getPathInPackage(),
          fileOptions: inputFile.getFileOptions()
          // sourceRoot: inputFile._resourceSlot.packageSourceBatch.sourceRoot
        }
      }
    }
  });

  if (Object.keys(data).length) {
    if (waiting)
      waiting.fileData = data;
    else
      fork.send({
        type: 'fileData',
        data: data
      });
  }
};
