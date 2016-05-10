HOST = null; // localhost
PORT = 8001;


// when the daemon started
var starttime = (new Date()).getTime();

var mem = process.memoryUsage();
var loc = 'node-' + process.env.DOTCLOUD_SERVICE_ID;
// every 10 seconds poll for the memory.
setInterval(function () {
  mem = process.memoryUsage();
}, 10*1000);


var fu = require("./fu"),
    util = require('util'),
    url = require("url"),
    qs = require("querystring"),
    hashlib = require("hashlib"),
    stackio = require("stack.io"),
    redis = require("redis").createClient(
            process.env.DOTCLOUD_REDIS_REDIS_PORT,
            process.env.DOTCLOUD_REDIS_REDIS_HOST
            );

redis.auth(process.env.DOTCLOUD_REDIS_REDIS_PASSWORD);
redis.on('error', function (msg) {
    console.log(msg);
});

var sessionSecret = null;
redis.multi()
    .setnx('sessionsecret', randomId(32))
    .get('sessionsecret')
    .exec(function (err, replies) {
        sessionSecret = replies[0];
    });

var io = stackio({'transport': process.env.DOTCLOUD_REDIS_REDIS_URL});

var MESSAGE_BACKLOG = 200,
    SESSION_TIMEOUT = 60; // 1 minute

var channel = new function () {
    var messages = [],
        callbacks = [];

    this.createMessage = function (nick, type, text) {
        var message = {
                nick: nick
                , type: type // "msg", "join", "part"
                , text: text
                , from: process.env.DOTCLOUD_SERVICE_ID
                , timestamp: (new Date()).getTime()
        };
        // Emit the new message object to keep the message backlog
        // synchronized across the nodes
        io.emit('chat_message', message);
    };

    this.appendMessage = function (message) {
        switch (message.type) {
            case "msg":
                util.puts("<" + message.nick + " (node-" + message.from +  ")> " + message.text);
                break;
            case "join":
                util.puts(message.nick + " join");
                break;
            case "part":
                util.puts(message.nick + " part");
                break;
        }
        messages.push(message);
        while (callbacks.length > 0) {
            callbacks.shift().callback([message]);
        }
        while (messages.length > MESSAGE_BACKLOG)
            messages.shift();
    };

    this.query = function (since, callback) {
        var matching = [];
        for (var i = 0; i < messages.length; i++) {
            var message = messages[i];
            if (message.timestamp > since)
                matching.push(message)
        }

        if (matching.length != 0) {
            callback(matching);
        } else {
            callbacks.push({ timestamp: new Date(), callback: callback });
        }
    };

    // clear old callbacks
    // they can hang around for at most 30 seconds.
    setInterval(function () {
        var now = new Date();
        while (callbacks.length > 0 && now - callbacks[0].timestamp > 30*1000) {
            callbacks.shift().callback([]);
        }
    }, 3000);
};

function createSession (nick, callback) {
    if (nick.length > 50)
        return callback(null);
    if (/[^\w_\-^!]/.exec(nick))
        return callback(null);

    sessionExists(nick, function (exists) {
        if (exists)
            callback(null);
        else {
            var session = loadSessionObject({
                nick: nick,
                id: hashlib.md5(sessionSecret + ':' + nick),
                timestamp: new Date(),
            }).save();
            callback(session);
        }
    });
}

function loadSessionObject(session) {
    session.save = function () {
        var key = 'session_' + session.id;
        redis.set(key, JSON.stringify(session));
        redis.expire(key, SESSION_TIMEOUT);
        return session;
    };
    session.poke = function () {
        redis.exists('session_' + session.id, function (err, exists) {
            if (!exists)
                return; // session does not exists anymore
            session.timestamp = new Date();
            session.save();
        });
        return session;
    };
    session.destroy = function () {
        channel.createMessage(session.nick, 'part');
        redis.del('session_' + session.id);
    };
    return session;
}

function getSessionById(id, callback) {
    redis.get('session_' + id, function (err, reply) {
        if (!reply) {
            callback(null);
            return;
        }
        reply = JSON.parse(reply);
        callback(loadSessionObject(reply));
    });
}

function getSessionByNick(nick, callback) {
    return getSessionById(hashlib.md5(sessionSecret + ':' + nick), callback);
}

function sessionExists(nick, callback) {
    redis.exists('session_' + hashlib.md5(sessionSecret + ':' + nick), function (err, exists) {
        callback(exists);
    });
}

fu.listen(Number(process.env.PORT || PORT), HOST);

fu.get("/", fu.staticHandler("index.html"));
fu.get("/style.css", fu.staticHandler("style.css"));
fu.get("/client.js", fu.staticHandler("client.js"));
fu.get("/jquery-1.7.min.js", fu.staticHandler("jquery-1.7.min.js"));


fu.get("/who", function (req, res) {
    var nicks = [];
    redis.keys('session_*', function (err, replies) {
        redis.mget(replies, function (err, replies) {
            for (i in replies) {
                var session = JSON.parse(replies[i]);
                nicks.push(session.nick);
            }
            res.simpleJSON(200, { nicks: nicks, rss: mem.rss, location: loc});
        });
    });
});

fu.get("/join", function (req, res) {
    var nick = qs.parse(url.parse(req.url).query).nick;
    if (nick == null || nick.length == 0) {
        res.simpleJSON(400, {error: "Bad nick."});
        return;
    }
    createSession(nick, function (session) {
        if (session === null) {
            res.simpleJSON(400, {error: "Nick in use"});
            return;
        }
        channel.createMessage(session.nick, "join");
        res.simpleJSON(200, { id: session.id
            , nick: session.nick
            , rss: mem.rss
            , location: loc
            , starttime: starttime
        });
    });
});

fu.get("/part", function (req, res) {
    var id = qs.parse(url.parse(req.url).query).id;
    getSessionById(id, function (session) {
        if (session)
            session.destroy();
        res.simpleJSON(200, { rss: mem.rss, location: loc });
    });
});

fu.get("/recv", function (req, res) {
    if (!qs.parse(url.parse(req.url).query).since) {
        res.simpleJSON(400, { error: "Must supply since parameter" });
        return;
    }
    var id = qs.parse(url.parse(req.url).query).id;
    var since = parseInt(qs.parse(url.parse(req.url).query).since, 10);
    getSessionById(id, function (session) {
        if (session === null) {
            res.simpleJSON(400, { error: "No such session id" });
            return;
        }
        session.poke();
        channel.query(since, function (messages) {
            session.poke();
            res.simpleJSON(200, { messages: messages, rss: mem.rss, location: loc });
        });
    });
});

fu.get("/send", function (req, res) {
    var id = qs.parse(url.parse(req.url).query).id;
    var text = qs.parse(url.parse(req.url).query).text;
    getSessionById(id, function (session) {
        if (!session || !text) {
            res.simpleJSON(400, { error: "No such session id" });
            return;
        }
        session.poke();
        channel.createMessage(session.nick, "msg", text);
        res.simpleJSON(200, { rss: mem.rss, location: loc });
    });
});

io.on('chat_message', function (message) {
    channel.appendMessage(message);
});

function randomId(length) {
    var callbacks = [
        function() {
            //48 - 57 ('0' - '9')
            return ((Math.round(Math.random() * 101)) % 10) + 48;
        },
        function() {
            //65 - 90 ('A' - 'Z')
            return ((Math.round(Math.random() * 101)) % 26) + 65;
        },
        function() {
            //97 - 122 ('a' - 'z')
            return ((Math.round(Math.random() * 1001)) % 26) + 97;
        }
    ];
    var result = '';
    for (var i = 0; i < length; i++) {
        var choice = Math.round(((Math.random() * 11) % (callbacks.length - 1)));
        result += String.fromCharCode(callbacks[choice]());
    }
    return result;
}
