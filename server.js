var MAX_ROOM_USERS = 200;
var DEBUG_MODE = true;

var static = require('node-static');
var http = require('http');
var file = new(static.Server)();
var app = http.createServer(function(req, res) {
    file.serve(req, res);
});
port = Number(process.env.PORT || 3000);
app.listen(port);

var io = require('socket.io').listen(app);

var colors = require('colors/safe');
colors.setTheme({
    silly: 'rainbow',
    input: 'grey',
    verbose: 'cyan',
    prompt: 'grey',
    info: 'green',
    data: 'grey',
    help: 'cyan',
    warn: 'yellow',
    debug: 'blue',
    error: 'red'
});

var rooms = {};
var lastUserId = 0;
var lastRoomId = 0;

var MessageType = {
    // A messages you send to server, when want to join or leave etc.
    JOIN: 'join',
    DISCONNECT: 'disconnect',

    // NSC
    SERVER_MESSAGE: 'server_message',

    // You receive room info as a response for join command. It contains information about
    // the room you joined, and it's users
    ROOM: 'room',

    // A messages you receive from server when another user want to join or leave etc.
    USER_JOIN: 'user_join',
    USER_READY: 'user_ready',
    USER_LEAVE: 'user_leave',

    // WebRtc signalling info, session and ice-framework related
    SDP: 'sdp',
    ICE_CANDIDATE: 'ice_candidate',

    // Errors... shit happens
    ERROR_ROOM_IS_FULL: 'error_room_is_full',
    ERROR_USER_INITIALIZED: 'error_user_initialized'
};

function User() {
    this.userId = ++lastUserId;
}
User.prototype = {
    getId: function() {
        return this.userId;
    }
};

function Room(name) {
    this.roomName = name;
    this.users = [];
    this.sockets = {};
}
Room.prototype = {
    getName: function() {
        return this.roomName;
    },
    getUsers: function() {
        return this.users;
    },
    getUserById: function(id) {
        return this.users.find(function(user) {
            return user.getId() === id;
        });
    },
    numUsers: function() {
        return this.users.length;
    },
    isEmpty: function() {
        return this.users.length === 0;
    },
    addUser: function(user, socket) {
        this.users.push(user);
        this.sockets[user.getId()] = socket;
    },
    removeUser: function(id) {
        this.users = this.users.filter(function(user) {
            return user.getId() !== id;
        });
        delete this.sockets[id];
    },
    sendTo: function(user, message, data) {
        var socket = this.sockets[user.getId()]; // Error: Cannot read property 'getId' of undefined
        socket.emit(message, data);
    },
    sendToId: function(userId, message, data) {
        return this.sendTo(this.getUserById(userId), message, data);
    },
    broadcastFrom: function(fromUser, message, data) {
        this.users.forEach(function(user) {
            if (user.getId() !== fromUser.getId()) {
                this.sendTo(user, message, data);
            }
        }, this);
    }
};

// socket
function handleSocket(socket) {

    //log('constructor has been called', 'input');
    var user = null; // TODO: почему юзер не присваивается в onJoin?
    var room = null;

    // NSC
    socket.on(MessageType.SERVER_MESSAGE, onServerMessage);

    socket.on(MessageType.JOIN, onJoin);
    socket.on(MessageType.SDP, onSdp);
    socket.on(MessageType.ICE_CANDIDATE, onIceCandidate);
    socket.on(MessageType.DISCONNECT, onLeave);
   
    // NSC
    function onServerMessage(message) {
        console.log('Message from peer: ' + message.candidate);
    }

    function onJoin(joinData) {
        log('IP: ' + socket.conn.remoteAddress, 'input');
        //debugger;
        // Somehow sent join request twice?
        if (user !== null || room !== null) {
            room.sendTo(user, MessageType.ERROR_USER_INITIALIZED);
            return;
        }

        // Let's get a room, or create if none still exists
        room = getOrCreateRoom(joinData.roomName);

        // TODO: корректная обработка максимального размера комнат
        // TODO: потестировать вывод сообщения о размере комнаты
        // TODO: Выдает ошибку при превышении лимита: "Cannot read property 'getId' of undefined". Взять обработку из shooter
        if (room.numUsers() >= MAX_ROOM_USERS) {
          room.sendTo(user, MessageType.ERROR_ROOM_IS_FULL);
          return;
        }

        // Add a new user
        room.addUser(user = new User(), socket);

        // Send room info to new user
        room.sendTo(user, MessageType.ROOM, {
            userId: user.getId(),
            roomName: room.getName(),
            users: room.getUsers()
        });
        
        // Notify others of a new user joined
        room.broadcastFrom(user, MessageType.USER_JOIN, {
            userId: user.getId(),
            users: room.getUsers()
        });
        
        /////////////////////////////////////////////////////
        
        // Notify others of a new user ready
        /*room.broadcastFrom(user, MessageType.USER_READY, {
            userId: user.getId(),
            users: room.getUsers()
        });*/
        
        /////////////////////////////////////////////////////
        
        log('onJoin ' + user.getId(), 'warn');
        //console.log('User %s joined room %s. Users in room: %d',
        console.log('Пользователь %s вошел в комнату %s. Всего в комнате: %d',
            user.getId(), room.getName(), room.numUsers());
    }
    function destroy() {
        log('Destructor is called');
    }
    function getOrCreateRoom(name) {
        var room;
        if (!name) {
            name = ++lastRoomId + '_room';
        }
        if (!rooms[name]) {
            room = new Room(name);
            rooms[name] = room;
        }
        return rooms[name];
    }

    function onLeave() {
        //log('onLeave', 'warn');
        //log(user, 'warn');
        if (user === null)
            log('onLeave неизвестный юзер', 'warn');
        else
            log('onLeave ' + user.getId(), 'warn');
        if (room === null) {
            return;
        }
        room.removeUser(user.getId());
        console.log('Пользователь %d покинул комнату %s. Осталось в комнате: %d',
            user.getId(), room.getName(), room.numUsers());
        if (room.isEmpty()) {
            console.log('Комната пуста - удаляем комнату %s', room.getName());
            delete rooms[room.getName()];
        }
        room.broadcastFrom(user, MessageType.USER_LEAVE, {
            userId: user.getId()
        });
    }

    function onSdp(message) {
        log('onSdp ' + user.getId() + '(' + message.userId + ')', 'warn');
        //console.log(socket);
        try {
            //console.log('type = ' + message.sdp.type);
            room.sendToId(message.userId, MessageType.SDP, {
                userId: user.getId(),
                sdp: message.sdp
            });
        } catch (e) {
            log('Ошибка: onSdp ' + user.getId() + '(' + message.userId + ')', 'error');
            //debugger;
        }
    }

    function onIceCandidate(message) {
        log('onIceCandidate ' + user.getId() + '(' + message.userId + ')', 'warn');
        try {
            room.sendToId(message.userId, MessageType.ICE_CANDIDATE, {
                userId: user.getId(),
                candidate: message.candidate
            });
        } catch (e) {
            log('Ошибка: onIceCandidate ' + user.getId() + '(' + message.userId + ')', 'error');
            // TODO: Пользователь message.userId отключился и user.getId() выдает исключение
            // TODO: Нужно избавиться от следов message.userId
            room.removeUser(message.userId);
            room.broadcastFrom(user, MessageType.USER_LEAVE, {
                userId: message.userId
            });
        }
    }
}

io.on('connection', handleSocket);
/*io.on('error', function() {
    console.log("Error occurred!");
});*/
console.log('Сервер запущен на порте: %d', port);

// Управление консолью на сервере
var stdin = process.openStdin();
stdin.addListener("data", function(d) {
    //console.log("you entered: [" + d.toString().trim() + "]");
    //console.log(d.toString().trim());
    //console.log(colors.warn(lastUserId));
    var command = '';
    var data = d.toString().trim();
    for (var i = 0; i < data.length; i++) {
        if (!(data[i] === ' ' && data[i + 1] === ' '))
            command += data[i];
    }
    var com = command.split(' ');
    //console.log(com[0]);
    //return;
    //console.log('[' + command + ']');
    //return;
    //var command = d.toString().trim().split(' ');
    //console.log(command);
    //return;
    switch (com[0]) {
        case 'peers':
            var _users = rooms['1'].getUsers();
            _users.forEach(function(item) {
                console.log(colors.warn(item.userId));
            });
            break;
        case 'drop':
            rooms['1'].removeUser(1);
            break;
        case 'rooms':
            console.log(colors.warn(rooms));
            break;
        case 'close':
            console.log('Сервер остановлен');
            io.close();
            break;
        default:
            console.log(colors.warn('Неверная команда'));
    }
});

function log(message, theme) {
    if (DEBUG_MODE) {
        var date = new Date();
        var time = date.getHours() + ':' + date.getMinutes() + ':' + date.getSeconds() + '.' + date.getMilliseconds();
        if (theme === undefined)
            console.log('[' + time + '] ' + message);
        else
            console.log(colors[theme.toString()]('[' + time + '] ' + message));
    }
}