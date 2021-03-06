/*jshint esversion: 6*/
var express = require('express');
var app = express();
var crontab = require("./crontab");
var restore = require("./restore");
var moment = require('moment');
var basicAuth = require('express-basic-auth');
var path = require('path');
var mime = require('mime-types');
var fs = require('fs');
var busboy = require('connect-busboy'); // for file upload
// include the routes
var routes = require("./routes").routes;
var bodyParser = require('body-parser');
const {promisify} = require('util');

const unlink = promisify(fs.unlink);

// basic auth
var BASIC_AUTH_USER = process.env.BASIC_AUTH_USER;
var BASIC_AUTH_PWD = process.env.BASIC_AUTH_PWD;

if (BASIC_AUTH_USER && BASIC_AUTH_PWD) {
    app.use(function(req, res, next) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Restricted Area"')
        next();
    });

	app.use(basicAuth({
        users: {
            [BASIC_AUTH_USER]: BASIC_AUTH_PWD
        }
    }))
}

// set the view engine to ejs
app.set('view engine', 'ejs');

app.use(bodyParser.json());       // to support JSON-encoded bodies
app.use(bodyParser.urlencoded({     // to support URL-encoded bodies
  extended: true
}));
app.use(busboy()); // to support file uploads

// include all folders
app.use(express.static(__dirname + '/public'));
app.use(express.static(__dirname + '/public/css'));
app.use(express.static(__dirname + '/public/js'));
app.use(express.static(__dirname + '/config'));
app.set('views', __dirname + '/views');

// set host to 127.0.0.1 or the value set by environment var HOST
app.set('host', (process.env.HOST || '127.0.0.1'));

// set port to 8000 or the value set by environment var PORT
app.set('port', (process.env.PORT || 8000));

// root page handler
app.get(routes.root, async function(req, res) {
    try {
        // reload the database before rendering
        await crontab.reload_db();
        // send all the required parameters
        const docs = await crontab.crontabs();
        res.render('index', {
            routes : JSON.stringify(routes),
            crontabs : JSON.stringify(docs),
            backups : await crontab.get_backup_names(),
            env : await crontab.get_env(),
            moment: moment
        });
    } catch (err) {
        console.log("Error: " + err);
        res.end("Error: " + err.toString());
    }
});

/*
Handle to save crontab to database
If it is a new job @param _id is set to -1
@param name, command, schedule, logging has to be sent with _id (if exists)
*/
app.post(routes.save, async function(req, res) {
    try {
        // new job
        if(req.body._id == -1){
            console.log('Create New:  %O', req.body );
            await crontab.create_new(req.body.name, req.body.command, req.body.schedule, req.body.logging, req.body.mailing);
        }
        // edit job
        else{
            console.log('Update:  %O', req.body );
            await crontab.update(req.body);
        }
        res.end("OK");
    } catch (err) {
        console.log("Error: " + err);
        res.end("Error: " + err.toString());
    }
});

// set stop to job
app.post(routes.stop, async function(req, res) {
    try {
        await crontab.status(req.body._id, true);
        res.end("OK");
    } catch (err) {
        console.log("Error: " + err);
        res.end("Error: " + err.toString());
    }
});

// set start to job
app.post(routes.start, async function(req, res) {
    try {
        await crontab.status(req.body._id, false);
        res.end("OK");
    } catch (err) {
        console.log("Error: " + err);
        res.end("Error: " + err.toString());
    }
});

// remove a job
app.post(routes.remove, async function(req, res) {
    try {
        await crontab.remove(req.body._id);
        res.end("OK");
    } catch (err) {
        console.log("Error: " + err);
        res.end("Error: " + err.toString());
    }
});

// run a job
app.post(routes.run,async function(req, res) {
    try {
        await crontab.runjob(req.body._id);
        res.end("OK");
    } catch (err) {
        console.log("Error: " + err);
        res.end("Error: " + err.toString());
    }
});

// set crontab. Needs env_vars to be passed
app.get(routes.crontab, async function(req, res, next) {
	try {
		console.info(`Start write_crontab!`);
		const result = await crontab.write_crontab(req.query.env_vars);
		console.log("Finished OK: " + result);
		res.end("Finished OK: " + result);
	} catch (err) {
		console.log("Error: " + err);
		res.end("Error: " + err.toString());
	}
});

// backup crontab db
app.get(routes.backup, async function(req, res) {
    try {
        await crontab.backup();
        res.end("OK");
    } catch (err) {
        console.log("Error: " + err);
        res.end("Error: " + err.toString());
    }
});

// This renders the restore page similar to backup page
app.get(routes.restore, async function(req, res) {
    try {
        const docs = await restore.crontabs(req.query.db);
        const backup_names = await crontab.get_backup_names();
        res.render('restore', {
            routes : JSON.stringify(routes),
            crontabs : JSON.stringify(docs),
            backups : backup_names,
            db: req.query.db
        });
    } catch (err) {
        console.log("Error: " + err);
        res.end("Error: " + err.toString());
    }
});

// delete backup db
app.get(routes.delete_backup, async function(req, res) {
    try {
        await restore.delete(req.query.db);
        res.end("OK");
    } catch (err) {
        console.log("Error: " + err);
        res.end("Error: " + err.toString());
    }
});

// restore from backup db
app.get(routes.restore_backup, async function(req, res) {
    try {
        await crontab.restore(req.query.db);
        res.end("OK");
    } catch (err) {
        console.log("Error: " + err);
        res.end("Error: " + err.toString());
    }
});

// export current crontab db so that user can download it
app.get(routes.export, function(req, res) {
	var file = __dirname + '/crontabs/crontab.db';

	var filename = path.basename(file);
	var mimetype = mime.lookup(file);

	res.setHeader('Content-disposition', 'attachment; filename=' + filename);
	res.setHeader('Content-type', mimetype);

	var filestream = fs.createReadStream(file);
	filestream.pipe(res);
});

// import from exported crontab db
app.post(routes.import, async function(req, res) {
	var fstream;
	req.pipe(req.busboy);
	req.busboy.on('file', function (fieldname, file, filename) {
		fstream = fs.createWriteStream(__dirname + '/crontabs/crontab.db');
		file.pipe(fstream);
		fstream.on('close', async function () {
			await crontab.reload_db();
			res.redirect(routes.root);
		});
	});
});

// import from current ACTUAL crontab
app.get(routes.import_crontab, async function(req, res) {
	try {
		console.info(`Start import_crontab!`);
		const result = await crontab.import_crontab();
		console.log("Finished OK: " + result);
		res.end("Finished OK: " + result);
	} catch (err) {
		console.log("Error: " + err);
		res.end("Error: " + err.toString());
	}
});

function sendLog(path, req, res) {
	if (fs.existsSync(path))
		res.sendFile(path);
	else
		res.end("No errors logged yet");
}

// get the log file a given job. id passed as query param
app.get(routes.logger, function(req, res) {
	let _file = crontab.log_folder + "/" + req.query.id + ".log";
	sendLog(_file, req, res);
});

// get the log file a given job. id passed as query param
app.get(routes.stdout, function(req, res) {
	let _file = crontab.log_folder + "/" + req.query.id + ".stdout.log";
	sendLog(_file, req, res);
});

// error handler
app.use(function(err, req, res, next) {
	var data = {};
	var statusCode = err.statusCode || 500;

	data.message = err.message || 'Internal Server Error';

	if (process.env.NODE_ENV === 'development' && err.stack) {
		data.stack = err.stack;
	}

	if (parseInt(data.statusCode) >= 500) {
		console.error(err);
	}

	res.status(statusCode).json(data);
});

process.on('SIGINT', function() {
  console.log("Exiting crontab-ui");
  process.exit();
})

process.on('SIGTERM', function() {
  console.log("Exiting crontab-ui");
  process.exit();
})

app.listen(app.get('port'), app.get('host'), async function() {
  console.log("Node version:", process.versions.node);
  fs.access(__dirname + "/crontabs/", fs.W_OK, function(err) {
    if(err){
      console.error("Write access to", __dirname + "/crontabs/", "DENIED.");
      process.exit(1);
    }
  });
  // If --autosave is used then we will also save whatever is in the db automatically without having to mention it explictly
  // we do this by watching log file and setting a on change hook to it
  if (process.argv.includes("--autosave")){
    fs.watchFile(__dirname + '/crontabs/crontab.db', () => {
        crontab.autosave_crontab();
        console.log("Attempted to autosave crontab");
    });
  }
  if (process.argv.includes("--reset")){
    console.log("Resetting crontab-ui");
    var crontabdb = __dirname + "/crontabs/crontab.db";
    var envdb = __dirname + "/crontabs/env.db";

    console.log("Deleting " + crontabdb);
    try{
        await unlink(crontabdb);
    } catch (e) {
      console.log("Unable to delete " + crontabdb);
    }

    console.log("Deleting " + envdb);
    try{
        await unlink(envdb);
    } catch (e) {
      console.log("Unable to delete " + envdb);
    }

    await crontab.reload_db();
  }
	console.log("Crontab UI is running at http://" + app.get('host') + ":" + app.get('port'));
});
