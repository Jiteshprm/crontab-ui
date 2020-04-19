/*jshint esversion: 6*/
//load database
// var Datastore = require('nedb-async');
const {AsyncNedb} = require('nedb-async');
const path = require("path");
const db = new AsyncNedb({filename: __dirname + '/crontabs/crontab.db'});
const exec = require('child_process').exec;
const fs = require('fs');
const cron_parser = require("cron-parser");

var cronPath = "/tmp";
exports.log_folder = __dirname + '/crontabs/logs';
exports.env_file = __dirname + '/crontabs/env.db';

if (process.env.CRON_PATH !== undefined) {
    console.log(`Path to crond files set using env variables ${process.env.CRON_PATH}`);
    cronPath = process.env.CRON_PATH;
}

crontab = function (name, command, schedule, stopped, logging, mailing, line_id) {
    console.log(`${name} ${mailing}`)
    let data = {};
    data.name = name;
    data.command = command;
    data.schedule = schedule;
    if (stopped !== null) {
        data.stopped = stopped;
    }
    data.timestamp = (new Date()).toString();
    data.logging = logging;
    if (!mailing)
        mailing = {};
    data.mailing = mailing;
    data.updated = true;
    data.real_id = line_id;
    return data;
};

exports.create_new = function (name, command, schedule, logging, mailing, line_id) { // sample async action
    return new Promise(async (resolve, reject) => {
        try {
            let tab = crontab(name, command, schedule, false, logging, mailing, line_id);
            tab.created = new Date().valueOf();
            await db.asyncInsert(tab);
            resolve ("OK");
        } catch (err) {
            reject (err);
        }
    });
};

exports.update = function (data) {
    return new Promise(async (resolve, reject) => {
        try {
            const res=await db.asyncUpdate({_id: data._id}, crontab(data.name, data.command, data.schedule, null, data.logging, data.mailing, data.real_id));
            resolve (res);
        } catch (err) {
            reject (err);
        }
    });
};

exports.status = function (_id, stopped) {
    return new Promise(async (resolve, reject) => {
        try {
            const res=await db.asyncUpdate({_id: _id}, {$set: {stopped: stopped}});
            resolve (res);
        } catch (err) {
            reject (err);
        }
    });
};

exports.remove = async function (_id) {
    return new Promise(async (resolve, reject) => {
        try {
            const res=await db.asyncRemove({_id: _id}, {});
            resolve (res);
        } catch (err) {
            reject (err);
        }
    });
};

// Iterates through all the crontab entries in the db and calls the callback with the entries
exports.crontabs = async function (callback) {
    await db.asyncFind({}, [['sort', {created: -1}]]).then(async function (docs) {
        console.info(docs)
        for (var i = 0; i < docs.length; i++) {
            if (docs[i].schedule == "@reboot")
                docs[i].next = "Next Reboot";
            else
                docs[i].next = cron_parser.parseExpression(docs[i].schedule).next().toString();
        }
        callback(docs);
    }, function (error) {
        console.error(error);
    });
};

exports.get_crontab = async function (_id, callback) {
    await db.asyncFind({_id: _id}).exec(function (err, docs) {
        callback(docs[0]);
    });
};

exports.runjob = async function (_id, callback) {
    await db.asyncFind({_id: _id}).exec(function (err, docs) {
        let res = docs[0];
        exec(res.command, function (error, stdout, stderr) {
            console.log(stdout);
        });
    });
};

const add_one_entry_error_handlers = function (tab) {
    return new Promise(async (resolve, reject) => {
        try {
            var crontab_string = "";
            if (!tab.stopped) {
                if (tab.command.includes("3>&1 1>&2 2>&3")) {
                    crontab_string += tab.schedule + " " + tab.command
                } else {
                    let stderr = path.join(cronPath, tab._id + ".stderr");
                    let stdout = path.join(cronPath, tab._id + ".stdout");
                    let log_file = path.join(exports.log_folder, tab._id + ".log");
                    let log_file_stdout = path.join(exports.log_folder, tab._id + ".stdout.log");

                    if (tab.command[tab.command.length - 1] != ";") // add semicolon
                        tab.command += ";";

                    crontab_string += tab.schedule + " ({ " + tab.command + " } | tee " + stdout + ") 3>&1 1>&2 2>&3 | tee " + stderr;

                    if (tab.logging && tab.logging == "true") {
                        crontab_string += "; if test -f " + stderr +
                            "; then date >> \"" + log_file + "\"" +
                            "; cat " + stderr + " >> \"" + log_file + "\"" +
                            "; fi";

                        crontab_string += "; if test -f " + stdout +
                            "; then date >> \"" + log_file_stdout + "\"" +
                            "; cat " + stdout + " >> \"" + log_file_stdout + "\"" +
                            "; fi";
                    }

                    if (tab.hook) {
                        crontab_string += "; if test -f " + stdout +
                            "; then " + tab.hook + " < " + stdout +
                            "; fi";
                    }

                    if (tab.mailing && JSON.stringify(tab.mailing) != "{}") {
                        crontab_string += "; /usr/local/bin/node " + __dirname + "/bin/crontab-ui-mailer.js " + tab._id + " " + stdout + " " + stderr;
                    }
                }
            }
            resolve (crontab_string);
        } catch (err) {
            reject (err);
        }
    });
};

function writeFileAsync(file_path, file_content) {
    return new Promise(function(resolve, reject) {
        fs.writeFile(file_path, file_content, function (err) {
            if (err) reject(err);
            else resolve("OK");
        });
    });
};


exports.write_crontab = function (env_vars) {
    return new Promise(async (resolve, reject) => {
        try {
            const docs = await db.asyncFind({}, [['sort', {created: -1}]]);
            for (let i = 0; i < docs.length; i++) {
                if (docs[i].schedule == "@reboot")
                    docs[i].next = "Next Reboot";
                else
                    docs[i].next = cron_parser.parseExpression(docs[i].schedule).next().toString();
            }
            console.info(docs);
            const add_all_error_handlers = docs.map(add_one_entry_error_handlers);
            const add_all_error_handlers_list = await Promise.all(add_all_error_handlers);
            console.info(`add_all_error_handlers_list: ${add_all_error_handlers_list}`);

            console.info(`env_vars: ${env_vars}`);
            var crontab_string = "";
            if (env_vars) {
                crontab_string = env_vars + "\n";
            }
            crontab_string += add_all_error_handlers_list.join("\n");
            crontab_string += "\n";
            console.info(`crontab_string: ${crontab_string}`);

            var fileName = "crontab";
            // In docker we're running as the root user, so we need to write the file as root and not crontab
            if (process.env.CRON_IN_DOCKER !== undefined) {
                fileName = "root";
            }

            await writeFileAsync(exports.env_file, env_vars);
            await writeFileAsync(path.join(cronPath, fileName), crontab_string);
            await execShellCommand("crontab " + path.join(cronPath, fileName));
            resolve("Successfully wrote to crontab")
        } catch (err) {
            reject (err);
        }
    });
};

exports.get_backup_names = function () {
    var backups = [];
    fs.readdirSync(__dirname + '/crontabs').forEach(function (file) {
        // file name begins with backup
        if (file.indexOf("backup") === 0) {
            backups.push(file);
        }
    });

    // Sort by date. Newest on top
    for (var i = 0; i < backups.length; i++) {
        var Ti = backups[i].split("backup")[1];
        Ti = new Date(Ti.substring(0, Ti.length - 3)).valueOf();
        for (var j = 0; j < i; j++) {
            var Tj = backups[j].split("backup")[1];
            Tj = new Date(Tj.substring(0, Tj.length - 3)).valueOf();
            if (Ti > Tj) {
                var temp = backups[i];
                backups[i] = backups[j];
                backups[j] = temp;
            }
        }
    }

    return backups;
};

function replace_regexp_no_exception(string, charToBeReplaced, regexp, charToReplace) {
    if (string.contains(charToBeReplaced)) {
        console.debug(string)
        return string//.replace(regexp, charToReplace)
    } else {
        return string
    }
}

exports.backup = function () {
    //TODO check if it failed
    console.log(new Date().toString())
    let dateAsString = new Date().toString()
    let dateReplaced = replace_regexp_no_exception(dateAsString, "+", /+/g, " ")
    dateReplaced = replace_regexp_no_exception(dateReplaced, " ", / /g, "_")
    dateReplaced = replace_regexp_no_exception(dateReplaced, ":", /:/g, "-")
    fs.createReadStream(__dirname + '/crontabs/crontab.db').pipe(fs.createWriteStream(__dirname + '/crontabs/backup ' + dateReplaced + '.db'));
};

exports.restore = function (db_name) {
    fs.createReadStream(__dirname + '/crontabs/' + db_name).pipe(fs.createWriteStream(__dirname + '/crontabs/crontab.db'));
    db.asyncLoadDatabase(); // reload the database
};

exports.reload_db = function () {
    console.log("Reload!")
    db.asyncLoadDatabase();
    // db.remove({ updated: false }, { multi: true }, function (err, numRemoved) {
    // 	if(err) {
    // 		throw err;
    // 	}
    // 	console.info(`Removed ${numRemoved} stale items!`);
    // });
};

exports.get_env = function () {
    if (fs.existsSync(exports.env_file)) {
        return fs.readFileSync(exports.env_file, 'utf8').replace("\n", "\n");
    }
    return "";
};

async function asyncForEach(array, callback) {
    for (let index = 0; index < array.length; index++) {
        await callback(array[index], index, array);
    }
}

const waitFor = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * https://medium.com/@ali.dev/how-to-use-promise-with-exec-in-node-js-a39c4d7bbf77
 * Executes a shell command and return it as a Promise.
 * @param cmd {string}
 * @return {Promise<string>}
 */
function execShellCommand(cmd) {
    const exec = require('child_process').exec;
    return new Promise((resolve, reject) => {
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.warn(error);
                reject(new Error(error));
            }
            resolve(stdout ? stdout : stderr);
        });
    });
}

const convert_line_to_id = function (line) { // sample async action
    return new Promise((resolve, reject) => {
        try {
            line = line.replace(/\t+/g, ' ');
            let regex = /^((\@[a-zA-Z]+\s+)|(([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+))/;
            let command = line.replace(regex, '').trim();
            let schedule = line.replace(command, '').trim();

            const regex_id = /\/tmp\/([a-zA-Z0-9]+).std/gm;
            let m;
            let line_id = '';

            while ((m = regex_id.exec(line)) !== null) {
                // This is necessary to avoid infinite loops with zero-width matches
                if (m.index === regex.lastIndex) {
                    regex.lastIndex++;
                }

                // The result can be accessed through the `m`-variable.
                m.forEach((match, groupIndex) => {
                    line_id = match;
                    console.log(`Line: ${line} - Found match, group ${groupIndex}: ${match}`);
                });
            }

            resolve([line_id, line, command, schedule]);
        } catch (err) {
            reject (err);
        }
    });
};


const check_if_record_exists = function ([line_id, line, command, schedule]) { // sample async action
    return new Promise(async (resolve, reject) => {
        try {
            if (line.length > 0) {
                const element = await db.asyncFindOne({$or: [{real_id: line_id}, {_id: line_id}]})
                resolve([line_id, line, command, schedule, true, element]);
            } else {
                resolve([line_id, line, command, schedule, false, false]);
            }
        } catch (err) {
            reject (err);
        }
    });
};


const update_or_add_element = function ([line_id, line, command, schedule, is_valid, element]) { // sample async action
    return new Promise(async (resolve, reject) => {
        try {
            if (is_valid) {
                if (!element) {
                    console.log(`line_id: ${line_id} - Create New`);
                    const name = new Date().getTime();
                    await exports.create_new(name, command, schedule, null, null, line_id);
                    resolve([1, 0]);
                } else {
                    console.log(`line_id: ${line_id} - Update`);
                    element.command = command;
                    element.updated = true;
                    element.real_id = line_id;
                    await exports.update(element);
                    resolve([0, 1]);
                }
            } else {
                resolve([0, 0]);
            }
        } catch (err) {
            reject (err);
        }
    });
};

function execute_crontab_entries_update() {
    return new Promise(async (resolve, reject) => {
        try{
            const all_cron_lines = await execShellCommand('crontab -l')
            const all_cron_lines_array = all_cron_lines.split("\n");

            const cron_ids = all_cron_lines_array.map(convert_line_to_id);
            const all_cron_ids_list = await Promise.all(cron_ids);
            console.info(`all_cron_ids_list: ${all_cron_ids_list}`);

            const check_if_all_record_exists = all_cron_ids_list.map(check_if_record_exists); // run the function over all items
            const records_exist = await Promise.all(check_if_all_record_exists);
            console.info(`records_exist: ${records_exist}`);

            const update_or_add_all_elements = records_exist.map(update_or_add_element); // run the function over all items
            const records_update_add = await Promise.all(update_or_add_all_elements);
            console.info(`records_update_add: ${records_update_add}`);

            const count_agg_func = function (a, b) { // sample async action
                return ([a[0] + b[0], a[1] + b[1]]);
            };
            const count_agg_all = records_update_add.reduce(count_agg_func); // run the function over all items
            console.info(`count_updated_result: ${count_agg_all}`);
            resolve(`Added: ${count_agg_all[0]}, Updated: ${count_agg_all[1]}`);
        } catch (err) {
            reject (err);
        }

    });
}

exports.import_crontab = function () {
    return new Promise(async (resolve, reject) => {
        try {
            const numReplaced = await db.asyncUpdate({updated: true}, {$set: {updated: false}}, {multi: true});
            console.info(`Updated to all items to update=false  , Number Replaced: ${numReplaced}!`);
            await db.asyncLoadDatabase();
            const successMessage = await execute_crontab_entries_update(resolve, reject);
            console.info("Update Finished!");
            console.info("Deleting not updated records...");
            await db.asyncLoadDatabase();
            const numRemoved=await db.asyncRemove({updated: false}, {multi: true});
            console.info("All Finished!");
            const msg = `${successMessage}, Deleted: ${numRemoved}`;
            console.info(msg);
            resolve(msg)
        } catch (err) {
            reject(err)
        }
    });
};


exports.remove_stale = function (callback) {
    console.info(`Removed stale items!`);
    // db.loadDatabase();
    //
    // db.remove({ updated: false }, { multi: true }, function (err, numRemoved) {
    // 	if(err) {
    // 		throw err;
    // 	}
    // 	console.info(`Removed ${numRemoved} stale items!`);
    // });
};

exports.autosave_crontab = function (callback) {
    let env_vars = exports.get_env();
    exports.set_crontab(env_vars, callback);
};
