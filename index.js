"use strict";

const bhttp = require("bhttp");
const cheerio = require("cheerio");

const { BBBurl } = require("./config");

bhttp.get(BBBurl);