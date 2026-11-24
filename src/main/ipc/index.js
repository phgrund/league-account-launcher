const accounts = require('./accounts');
const launch = require('./launch');
const config = require('./config');

function registerAll() {
    accounts.register();
    launch.register();
    config.register();
}

module.exports = { registerAll };
