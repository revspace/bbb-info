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

const mqttClient = mqtt.connect("mqtt://test.mosquitto.org");
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

	let i=0;

	function id() {
		i++;
		return i.toString();
	}

	const sock = new SockJS(`https://${BBBhost}/html5client/sockjs`);

	sock.onopen = function() {
		sock.send(JSON.stringify({"msg":"connect","version":"1","support":["1","pre2","pre1"]}));
		sock.send(JSON.stringify({"msg":"sub","id":data.internalUserID,"name":"meteor_autoupdate_clientVersions","params":[]}));
		sock.send(JSON.stringify({"msg":"method","method":"userChangedLocalSettings","params":[{"application":{"animations":true,"chatAudioAlerts":false,"chatPushAlerts":false,"userJoinAudioAlerts":false,"userJoinPushAlerts":false,"fallbackLocale":"en","overrideLocale":null,"locale":"en","isRTL":false},"audio":{"inputDeviceId":"undefined","outputDeviceId":"undefined"},"dataSaving":{"viewParticipantsWebcams":true,"viewScreenshare":true}}],"id":id()}));
		sock.send(JSON.stringify({"msg":"method","method":"logClient","params":["info","Connection to Meteor took 2.05s","joinhandler_component_initial_connection_time",{"attemptForUserInfo":{},"timeToConnect":"2.05","clientURL":"https://meet.nluug.nl/html5client/join?sessionToken=8ar0wxa9u1mwqggw"}],"id":id()}));
		sock.send(JSON.stringify({"msg":"method","method":"validateAuthToken","params":authParams,"id":id()}));
		sock.send(JSON.stringify({"msg":"sub","id":"aaaaaaaa","name":"users","params":[]}));
	};

	let users = new Map();
	let lastPublish = undefined;

	const debouncedUpdate = debounce(() => {
		let size = users.size;
		if (size != lastPublish)  {
			console.log("publishing", size);
			mqttClient.publish('revspace/b', size.toString(), {retain: true});
			lastPublish = size;
		}
	}, 200);

	sock.onmessage = function(e) {
		let data = JSON.parse(e.data);
		console.log(data);
		if (data.collection == "users") {
			if (data.fields.validated == false) {
				users.delete(data.id);
			} else if (data.fields.name != undefined) {
				users.set(data.id, data.fields.name);
			}
			debouncedUpdate();
		} else if (data.collection == "ping-pong") {
			sock.send(JSON.stringify({"msg":"method","method":"ping","params":[],"id":id()}));
		}
	};
}).catch((e) => {
	console.error(e);
});