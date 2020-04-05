/*jshint esversion: 6*/
//load database
var Datastore = require('nedb');
var path = require("path");
var db = new Datastore({ filename: __dirname + '/crontabs/crontab.db' });
var cronPath = "/tmp";

if(process.env.CRON_PATH !== undefined) {
	console.log(`Path to crond files set using env variables ${process.env.CRON_PATH}`);
	cronPath = process.env.CRON_PATH;
}

db.loadDatabase(function (err) {
	console.log("Loading DB...")
	if (err) throw err; // no hope, just terminate
});

var exec = require('child_process').exec;
var fs = require('fs');
var cron_parser = require("cron-parser");

exports.log_folder = __dirname + '/crontabs/logs';
exports.env_file = __dirname + '/crontabs/env.db';

crontab = function(name, command, schedule, stopped, logging, mailing, line_id){
	console.log(`${name} ${mailing}`)
	let data = {};
	data.name = name;
	data.command = command;
	data.schedule = schedule;
	if(stopped !== null) {
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

// function Person(name, command, schedule, stopped, timestamp, logging, mailing,updated, real_id){
// 	this.name = name;
// 	this.command = command;
// 	this.schedule = schedule;
// 	this.stopped = stopped;
// 	this.timestamp = timestamp;
// 	this.logging = logging;
// 	this.mailing = mailing;
// 	this.updated = updated;
// 	this.real_id = real_id;
// }
//
// Person.prototype.getItems = function(callback) {
// 	db.find({}, callback);
// }

exports.create_new = function(name, command, schedule, logging, mailing, line_id){
	let tab = crontab(name, command, schedule, false, logging, mailing, line_id);
	tab.created = new Date().valueOf();
	db.insert(tab);
};

exports.update = function(data){
	db.update({_id: data._id}, crontab(data.name, data.command, data.schedule, null, data.logging, data.mailing, data.real_id));
};

exports.status = function(_id, stopped){
	db.update({_id: _id},{$set: {stopped: stopped}});
};

exports.remove = function(_id){
	db.remove({_id: _id}, {});
};

// Iterates through all the crontab entries in the db and calls the callback with the entries
exports.crontabs = function(callback){
	db.find({}).sort({ created: -1 }).exec(function(err, docs){
		for(var i=0; i<docs.length; i++){
			if(docs[i].schedule == "@reboot")
				docs[i].next = "Next Reboot";
			else
				docs[i].next = cron_parser.parseExpression(docs[i].schedule).next().toString();
		}
		callback(docs);
	});
};

exports.get_crontab = function(_id, callback) {
	db.find({_id: _id}).exec(function(err, docs){
		callback(docs[0]);
	});
};

exports.runjob = function(_id, callback) {
	db.find({_id: _id}).exec(function(err, docs){
		let res = docs[0];
		exec(res.command, function(error, stdout, stderr){
			console.log(stdout);
		});
	});
};

// Set actual crontab file from the db
exports.set_crontab = function(env_vars, callback){
	exports.crontabs( function(tabs){
		var crontab_string = "";
		if (env_vars) {
			crontab_string = env_vars + "\n";
		}
		tabs.forEach(function(tab){
			if(!tab.stopped) {
				if (tab.command.includes("3>&1 1>&2 2>&3")){
					crontab_string += tab.schedule + " " + tab.command
				} else {
					let stderr = path.join(cronPath, tab._id + ".stderr");
					let stdout = path.join(cronPath, tab._id + ".stdout");
					let log_file = path.join(exports.log_folder, tab._id + ".log");
					let log_file_stdout = path.join(exports.log_folder, tab._id + ".stdout.log");

					if(tab.command[tab.command.length-1] != ";") // add semicolon
						tab.command +=";";

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

					if (tab.mailing && JSON.stringify(tab.mailing) != "{}"){
						crontab_string += "; /usr/local/bin/node " + __dirname + "/bin/crontab-ui-mailer.js " + tab._id + " " + stdout + " " + stderr;
					}
				}


				crontab_string += "\n";
			}
		});

		fs.writeFile(exports.env_file, env_vars, function(err) {
			if (err) callback(err);
			// In docker we're running as the root user, so we need to write the file as root and not crontab
			var fileName = "crontab"
			if(process.env.CRON_IN_DOCKER !== undefined) {
				fileName = "root"
			}
			fs.writeFile(path.join(cronPath, fileName), crontab_string, function(err) {
				if (err) return callback(err);
				/// In docker we're running crond using busybox implementation of crond
				/// It is launched as part of the container startup process, so no need to run it again
				if(process.env.CRON_IN_DOCKER === undefined) {
					exec("crontab " + path.join(cronPath, "crontab"), function(err) {
						if (err) return callback(err);
						else callback();
					});
				} else {
					callback();
				}
			});
		});
	});
};

exports.get_backup_names = function(){
	var backups = [];
	fs.readdirSync(__dirname + '/crontabs').forEach(function(file){
		// file name begins with backup
		if(file.indexOf("backup") === 0){
			backups.push(file);
		}
	});

	// Sort by date. Newest on top
	for(var i=0; i<backups.length; i++){
		var Ti = backups[i].split("backup")[1];
		Ti = new Date(Ti.substring(0, Ti.length-3)).valueOf();
		for(var j=0; j<i; j++){
			var Tj = backups[j].split("backup")[1];
			Tj = new Date(Tj.substring(0, Tj.length-3)).valueOf();
			if(Ti > Tj){
				var temp = backups[i];
				backups[i] = backups[j];
				backups[j] = temp;
			}
		}
	}

	return backups;
};

function replace_regexp_no_exception(string,charToBeReplaced, regexp, charToReplace) {
    if (string.contains(charToBeReplaced)){
        console.debug(string)
        return string//.replace(regexp, charToReplace)
    } else {
        return string
    }
}

exports.backup = function(){
	//TODO check if it failed
	console.log(new Date().toString())
    let dateAsString = new Date().toString()
    let dateReplaced = replace_regexp_no_exception(dateAsString, "+",/+/g, " ")
    dateReplaced = replace_regexp_no_exception(dateReplaced, " ",/ /g, "_")
    dateReplaced = replace_regexp_no_exception(dateReplaced, ":",/:/g, "-")
	fs.createReadStream( __dirname + '/crontabs/crontab.db').pipe(fs.createWriteStream( __dirname + '/crontabs/backup ' + dateReplaced + '.db'));
};

exports.restore = function(db_name){
	fs.createReadStream( __dirname + '/crontabs/' + db_name).pipe(fs.createWriteStream( __dirname + '/crontabs/crontab.db'));
	db.loadDatabase(); // reload the database
};

exports.reload_db = function(){
	console.log("Reload!")
	db.loadDatabase();
	// db.remove({ updated: false }, { multi: true }, function (err, numRemoved) {
	// 	if(err) {
	// 		throw err;
	// 	}
	// 	console.info(`Removed ${numRemoved} stale items!`);
	// });
};

exports.get_env = function(){
	if (fs.existsSync(exports.env_file)) {
		return fs.readFileSync(exports.env_file , 'utf8').replace("\n", "\n");
	}
	return "";
};



exports.import_crontab = function(){
	// Set an existing field's value
	db.update({ updated: true }, { $set: { updated: false } }, { multi: true }, function (err, numReplaced) {
		if(err) {
			throw err;
		}
		console.info(`Updated to all items to update=false  , Number Replaced: ${numReplaced}!`);
	});
	db.loadDatabase();

	exec("crontab -l", function(error, stdout, stderr){
		// db.remove({}, { multi: true }, function (err, numRemoved) {
		// });



		let lines = stdout.split("\n");
		let namePrefix = new Date().getTime();

		lines.forEach(function(line, index){
			let names = [];
			line = line.replace(/\t+/g, ' ');
			let regex = /^((\@[a-zA-Z]+\s+)|(([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+))/;
			let command = line.replace(regex, '').trim();
			let schedule = line.replace(command, '').trim();

			const regex_id = /\/tmp\/([a-zA-Z0-9]+).std/gm;
			let m;
			let line_id='';
			while ((m = regex_id.exec(line)) !== null) {
				// This is necessary to avoid infinite loops with zero-width matches
				if (m.index === regex.lastIndex) {
					regex.lastIndex++;
				}

				// The result can be accessed through the `m`-variable.
				m.forEach((match, groupIndex) => {
					line_id = match;
					console.log(`Index: ${index} - Found match, group ${groupIndex}: ${match}`);
				});
			}

			let is_valid = false;
			try { is_valid = cron_parser.parseString(line).expressions.length > 0; } catch (e){}

			if(command && schedule && is_valid && line_id){
				let name = namePrefix + '_' + index;
				console.log(`Index: ${index} - line_id: ${line_id}`);
				db.findOne({ $or: [{ real_id: line_id }, { _id: line_id }]  }, function(err, doc) {
					if(err) {
						throw err;
					}
					console.log(`Index: ${index} - ${doc}`);
					if(!doc){
						names.push(name)
						console.log(`Index: ${index} - Create New`);
						exports.create_new(name, command, schedule, null, null,  line_id);
					}
					else{
						names.push(doc.name)
						console.log(`Index: ${index} - Update`);
						doc.command = command;
						doc.updated = true;
						doc.real_id = line_id;
						exports.update(doc);
					}
				});
				// db.loadDatabase();

				// db.remove({ updated: false }, { multi: true }, function (err, numRemoved) {
				// 	if(err) {
				// 		throw err;
				// 	}
				// 	console.info(`Removed ${numRemoved} stale items!`);
				// });

			} else {
				console.info(`Index: ${index} - Error when updating from crontab!`);
			}



		});


		// const record = new Person();
		// record.getItems((err, docs) => {
		// 	if(err) {
		// 		throw err;
		// 	}
		// 	console.log(`Docs: ${docs}`);
		// });

		// db.find({}).sort({ created: -1 }).exec(function (err, docs) {
		// 	if(err) {
		// 		throw err;
		// 	}
		// 	console.log(`Docs1: ${docs}`);
		// 	docs.forEach(function(doc, index){
		// 		console.log(`Index: ${index} - ${doc}`);
		// 		if(!doc){
		// 			console.log(`Index: ${index} - Create New`);
		// 		}
		// 		else{
		// 			// names.push(doc.name)
		// 			console.log(`Index: ${index} - Update`);
		// 			// doc.command = command;
		// 			// doc.updated = true;
		// 			// exports.update(doc);
		// 		}
		// 	});
		// });
	});
};

exports.remove_stale = function(callback) {
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

exports.autosave_crontab = function(callback) {
	let env_vars = exports.get_env();
	exports.set_crontab(env_vars, callback);
};
