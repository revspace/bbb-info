"use strict";

const bhttp = require("bhttp");
const cheerio = require("cheerio");
const Promise = require("bluebird");
const urlLib = require("url");
const cookieLib = require("cookie");
const SockJS = require("sockjs-client");
const debounce = require("debounce");
const mqtt = require("mqtt");

const { BBBurl } = require("./config");
const BBBhost = urlLib.parse(BBBurl).host;

const mqttClient = mqtt.connect("mqtt://mosquitto.space.revspace.nl");
const session = bhttp.session({ headers: {"user-agent": "BigBlueButtonBot/0.0.1"} });

Promise.try(() => {
	return session.get(BBBurl);
}).then(({body}) => {
	return cheerio.load(body.toString());
}).then(($) => {
	let authToken = $(`input[name="authenticity_token"]`).attr('value');
	let formUrl = $(`form `).attr('action');
	return session.post(BBBurl, {
		utf8: "✓",
		"authenticity_token": authToken,
		[`${formUrl}[join_name]`]: "bar"
	});
}).then((a) => {
	let sessionToken = urlLib.parse(a.request.url).query;
	return session.get(`https://${BBBhost}/bigbluebutton/api/enter?${sessionToken}`);
}).then((resp) => {
	let cookies = cookieLib.parse(resp.request.options.headers.cookie);
	let data = resp.body.response;

	const authParams = [
		data.meetingID,
		data.internalUserID,
		data.authToken,
		cookies.guest_id
	];

	let lastPing = new Date().getTime();

	let i=0;

	function id() {
		i++;
		return i.toString();
	}

	const sock = new SockJS(`https://${BBBhost}/html5client/sockjs`);

	sock.onopen = function() {
		sock.send(JSON.stringify({"msg":"connect","version":"1","support":["1","pre2","pre1"]}));
		sock.send(JSON.stringify({"msg":"method","method":"userChangedLocalSettings","params":[{"application":{"animations":true,"chatAudioAlerts":false,"chatPushAlerts":false,"userJoinAudioAlerts":false,"userJoinPushAlerts":false,"fallbackLocale":"en","overrideLocale":null,"locale":"en","isRTL":false},"audio":{"inputDeviceId":"undefined","outputDeviceId":"undefined"},"dataSaving":{"viewParticipantsWebcams":true,"viewScreenshare":true}}],"id":id()}));
		sock.send(JSON.stringify({"msg":"method","method":"validateAuthToken","params":authParams,"id":id()}));
		sock.send(JSON.stringify({"msg":"sub","id":"Unique_String_1","name":"users","params":[]}));
		sock.send(JSON.stringify({"msg":"sub","id":"Unique_String_2","name":"ping-pong","params":[]}));
	};

	let users = new Map();
	let lastPublish = undefined;

	const debouncedUpdate = debounce(() => {
		let count = 0;
		let onlineUsers = [];
		users.forEach((a) => {
			if (a.validated != false && a.validated != null && a.loggedOut != true) {
				count += 1;
				onlineUsers.push(a.name);
			} else {
				//console.log("non-connected user?", a);
			}
		});
		if (count != lastPublish)  {
			console.log("publishing", count);
			mqttClient.publish('revspace/b', count.toString(), {retain: true});
			lastPublish = count;
			//console.log("all users");
			//console.log(users);
		}
		console.log("users online", onlineUsers);
	}, 200);

	sock.onmessage = function(e) {
		let data = JSON.parse(e.data);
		// console.log(data);
		if (data.collection == "users") {
			if (data.msg == "added") {
				users.set(data.id, data.fields);
			} else if (data.msg == "changed") {
				if (users.has(data.id)) { // should be the case
					users.set(data.id, {
						...users.get(data.id),
						...data.fields
					});
				} else {
					users.set(data.id, data.fields);
				}
			} else if (data.msg == "removed") {
				users.delete(data.id);
			}
			debouncedUpdate();
		} else if (data.collection == "ping-pong") {
			lastPing = new Date().getTime();
			console.log("ping-pong");
			sock.send(JSON.stringify({"msg":"method","method":"ping","params":[],"id":id()}));
		} else if (data.msg == "ping") {
			console.log("ping");
			sock.send(JSON.stringify({"msg":"pong"}));
		}
	};

	function checkLastPing() {
		if (new Date().getTime() - lastPing > 30 * 1000) {
			console.log("Exiting Due To Ping Timeout");
			process.exit();
		}
		setTimeout(() => {
			checkLastPing();
		}, 1000);
	}

	checkLastPing();

	// function exit() {
	// 	console.log("exiting");
	// 	sock.send(JSON.stringify({"msg":"method","method":"userLeftMeeting","params":[],"id":id()}));
	// 	sock.close(1000);
	// 	process.exit();
	// }

	// process.on('exit', exit);
	// process.on('SIGINT', exit);
	// process.on('SIGUSR1', exit);
	// process.on('SIGUSR2', exit);
}).catch((e) => {
	console.error(e);
});
