'use strict';
/**
 * write_whole.js - write a file whole or not at all (Node 8).
 *
 * The text goes to a temp file beside it, which is then renamed over it in one step. The head unit loses
 * power at every switch-off; a file written in place when that happens is left cut short, and the next start
 * reads broken JSON (a lost AI key, a lost saved position).
 *
 *   writeWhole(file, text, mode)   mode (optional): the file's permissions, e.g. 0o600 for a key
 */
const fs = require('fs');

function writeWhole(file, text, mode) {
    const tmp = file + '.' + process.pid + '.tmp';
    try {
        fs.writeFileSync(tmp, text, mode ? { encoding: 'utf8', mode } : 'utf8');
        fs.renameSync(tmp, file);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) { /* not there */ }
        throw e;
    }
}

module.exports = { writeWhole };
