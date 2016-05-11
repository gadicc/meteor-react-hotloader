var packageName = 'ecmascript';
var supported = new PackageVersion('0.4.3');

// Avoid version check in these circumstances
if (process.env.INSIDE_ACCELERATOR
    || process.env.NODE_ENV==='production'
    || process.argv.indexOf('test') !== -1
    || process.argv.indexOf('test-packages') !== -1)
  return;

var current = new PackageVersion(
  MeteorFilesHelpers.getPackageVersion(packageName)
);

function log(func, text) {
  func("[gadicc:hot] " + packageName + " - current: v" + current.version
    + ', supported v' + supported.version + '; ' + text);
}

if (current.major > supported.major)
  log(function(text) { throw new Error(text) },
    "Look out for newer versions and issues on meteor-hmr GitHub.");
else if (current.minor > supported.minor)
  log(console.warn,
    "Something is liable to break in these circumstances. " +
    "Look out for newer versions and issues on meteor-hmr GitHub.");
else if (current.patch > supported.patch)
  log(console.log,
    "This might be ok but look out for newer versions and issues " +
    "on meteor-hmr GitHub.");  