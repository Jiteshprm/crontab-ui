//load database
const {AsyncNedb} = require('nedb-async');
const {promisify} = require('util');
var fs = require('fs');

const unlink = promisify(fs.unlink);

exports.crontabs = function(db_name){
	return new Promise(async (resolve, reject) => {
		try{
			const db = new AsyncNedb({filename: __dirname + '/crontabs/' + db_name});
			await db.asyncLoadDatabase();
			const docs=await db.asyncFind({}, [['sort', {created: -1}]]);
			resolve (docs);
		} catch (err) {
			reject (err);
		}
	});
};

exports.delete = async function(db_name){
	await unlink(__dirname + '/crontabs/' + db_name);
};
