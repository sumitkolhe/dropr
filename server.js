"use strict";

var app = require("express")();
var server = require("http").createServer(app);
var io = require("socket.io").listen(server);
var fs = require("fs");

var serverPort = process.env.PORT || 80;
var socketStates = {};
var users = {};
var tunnels = {};
var testingTunnel = "ABCDEF";

server.listen(serverPort, function () {
  console.log("server is running on " + serverPort);
});

function fileTransferLoop(tunnel, res, callback) {
  if (tunnel["complete"] && tunnel["buffer"].length <= 0) {
    console.log("Done");
    callback(true);
    return;
  }
  var bytes = tunnel["buffer"].shift();
  if (bytes != undefined) res.write(bytes);

  tunnel["listener"] = function () {
    fileTransferLoop(tunnel, res, callback);
  };
  if (!tunnel["complete"]) tunnel.uploader.emit("transferUpMore");
  else {
    console.log("Cancelled transfer");
    callback(false);
  }
}

app.get("/", function (req, res) {
  res.sendFile(__dirname + "/client/index.html");
});

app.get("/tunnel/:tunnelId", function (req, res) {
  var tunnelId = req.params["tunnelId"];

  if (tunnelId in tunnels) {
    var tunnel = tunnels[tunnelId];
    if (tunnel["listening"] == true) {
      res.writeHead(404);
      res.write("Invalid Tunnel");
      res.end();
      return;
    }

    tunnel["listening"] = true;

    var headers = {
      "Content-Type": tunnel["file"]["type"],
      "Content-Disposition":
        'attachment;filename*="' + tunnel["file"]["name"] + '"',
    };
    var userAgent = (req.headers["user-agent"] || "").toLowerCase();
    if (userAgent.indexOf("msie") >= 0 || userAgent.indexOf("chrome") >= 0) {
      headers["Content-Disposition"] =
        "attachment; filename=" + encodeURIComponent(tunnel["file"]["name"]);
    } else if (userAgent.indexOf("firefox") >= 0) {
      headers["Content-Disposition"] =
        "attachment; filename*=\"utf8''" +
        encodeURIComponent(tunnel["file"]["name"]) +
        '"';
    } else {
      /* safari and other browsers */
      headers["Content-Disposition"] =
        "attachment; filename=" +
        new Buffer(tunnel["file"]["name"]).toString("binary");
    }
    res.writeHead(200, headers);

    res.on("close", function () {
      if (tunnels[tunnelId]["complete"] != true) {
        tunnels[tunnelId]["complete"] = true;
      }
    });

    fileTransferLoop(tunnel, res, function (successful) {
      res.end(undefined, "binary");
      if (successful) tunnels[tunnelId].uploader.emit("tunnelClosed");
      else tunnels[tunnelId].uploader.emit("tunnelAborted");
      tunnels[tunnelId].downloader.emit("tunnelClosed");

      //reset socketStates
      socketStates[tunnels[tunnelId].uploader.id].state = 3;
      socketStates[tunnels[tunnelId].uploader.id].pendingFile = undefined;
      socketStates[tunnels[tunnelId].uploader.id].tunnelId = undefined;
      socketStates[tunnels[tunnelId].downloader.id].state = 3;
      socketStates[tunnels[tunnelId].downloader.id].tunnelId = undefined;

      delete tunnels[tunnelId];
    });
  } else {
    res.writeHead(404);
    res.write("Invalid Tunnel");
    res.end();
  }
});

io.on("connection", function (socket) {
  var curUserId = makeSelfId();

  socketStates[socket.id] = {
    selfId: curUserId,
    state: 0,
    partner: undefined,
    pendingFile: undefined,
  };

  users[curUserId] = socket;

  //console.log("User with code " + curUserId + " connected on " + socket.id);

  socket.on("disconnect", function () {
    if (socketStates[socket.id] != undefined) {
      //console.log("User " + socketStates[socket.id].selfId + " disconnecting");
      if (socketStates[socket.id].partner != undefined) {
        socketStates[socket.id].partner.emit(
          "refresh",
          "Your partner decided to disconnect"
        );
      }
      delete socketStates[socket.id];
      if (users[curUserId] != undefined) {
        delete users[curUserId];
      }
    } else {
      console.log("Untracked user disconnected");
    }
  });

  socket.on("readyRequest", function () {
    socket.emit("readyReply", socketStates[socket.id].selfId);
  });

  socket.on("stateReply", function (s) {
    if (s != 0) {
      //maybe a leftover connection, demand a refresh
      socket.emit("refresh");
    }
  });

  socket.on("connectRequest", function (targetId) {
    socketStates[socket.id].state = 1;

    //check if valid
    if (!(targetId in users)) {
      //reject connect request
      socket.emit("connectReply", { status: 404 });
      socketStates[socket.id].state = 0;
      return;
    } else if (socketStates[users[targetId].id].state != 0) {
      socket.emit("connectReply", { status: 202 });
      socketStates[socket.id].state = 0;
      return;
    }
    socket.emit("connectReply", { status: 201 });
    users[targetId].emit("incomingConnect", {
      partnerId: socketStates[socket.id].selfId,
    });
    socketStates[users[targetId].id].state = 2;
    socketStates[users[targetId].id].partner = socket;
    socketStates[socket.id].partner = users[targetId];
  });

  socket.on("connectReject", function (targetId) {
    if (socketStates[socket.id].state != 2) {
      return;
    }
    if (socketStates[socket.id].partner == undefined) {
      return;
    }

    socketStates[socketStates[socket.id].partner.id].partner = undefined;
    socketStates[socketStates[socket.id].partner.id].state = 0;
    socketStates[socket.id].partner.emit("connectReply", { status: 204 });

    socketStates[socket.id].partner = undefined;
    socketStates[socket.id].state = 0;
  });

  socket.on("connectAccept", function (targetId) {
    if (socketStates[socket.id].state != 2) {
      return;
    }
    if (socketStates[socket.id].partner == undefined) {
      return;
    }

    socketStates[socketStates[socket.id].partner.id].state = 3;
    socketStates[socket.id].partner.emit("connectReply", { status: 200 });

    socketStates[socket.id].state = 3;
    socket.emit("connectReply", { status: 300 });
  });

  socket.on("transferRequest", function (data) {
    socketStates[socket.id].state = 4;
    var partnerState = socketStates[socketStates[socket.id].partner.id];
    if (partnerState == undefined) {
      //partner disconnected
      // #TODO
      socket.emit("transferReply", { status: 404 });
      return;
    }

    //check if valid
    if (!(partnerState.selfId in users)) {
      //partner disconnected
      // #TODO
      socket.emit("transferReply", { status: 404 });
      return;
    } else if (partnerState.state != 3) {
      //invalid partner state
      // #TODO
      socket.emit("transferReply", { status: 403 });
      return;
    }
    socket.emit("transferReply", { status: 201 });
    var fileDat = { name: data.name, size: data.size, type: data.type };
    socketStates[socket.id].partner.emit("incomingTransfer", fileDat);
    socketStates[socket.id].pendingFile = fileDat;
    partnerState.state = 4;
  });

  socket.on("transferReject", function (targetId) {
    if (socketStates[socket.id].state != 4) {
      return;
    }
    if (socketStates[socket.id].partner == undefined) {
      return;
    }

    socketStates[socketStates[socket.id].partner.id].state = 3;
    socketStates[socketStates[socket.id].partner.id].pendingFile = undefined;
    socketStates[socket.id].partner.emit("transferReply", { status: 204 });

    socketStates[socket.id].state = 3;
  });

  socket.on("transferAccept", function (targetId) {
    if (socketStates[socket.id].state != 4) {
      return;
    }
    if (socketStates[socket.id].partner == undefined) {
      return;
    }

    var tunnelId = createTunnel(
      socketStates[socket.id].partner,
      socket,
      socketStates[socketStates[socket.id].partner.id].pendingFile
    );

    socketStates[socketStates[socket.id].partner.id].state = 5;
    socketStates[socketStates[socket.id].partner.id].tunnelId = tunnelId;
    socketStates[socket.id].partner.emit("transferReply", { status: 200 });

    socketStates[socket.id].state = 5;
    socketStates[socket.id].tunnelId = tunnelId;
    socket.emit("transferReply", { status: 300, tunnelId: tunnelId });
  });

  socket.on("transferUpStream", function (data) {
    var tunId = socketStates[socket.id].tunnelId;
    if (tunnels[tunId] == undefined) {
      return;
    }
    tunnels[tunId]["buffer"].push(data["Data"]);
    if (tunnels[tunId]["listener"] != undefined) {
      tunnels[tunId]["listener"]();
    }
  });

  socket.on("transferComplete", function () {
    var tunId = socketStates[socket.id].tunnelId;
    tunnels[tunId]["complete"] = true;
    if (tunnels[tunId]["listener"] != undefined) {
      tunnels[tunId]["listener"]();
    }
  });

  socket.emit("stateQuery");
});

function makeSelfId() {
  var text = "";
  var possible = "0123456789";

  for (var i = 0; i < 6; i++)
    text += possible.charAt(Math.floor(Math.random() * possible.length));

  if (text in users) {
    return makeSelfId();
  }

  return text;
}

function makeTunnelId() {
  var text = "";
  var possible = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  for (var i = 0; i < 32; i++)
    text += possible.charAt(Math.floor(Math.random() * possible.length));

  if (text in tunnels) {
    return makeTunnelId();
  }

  return text;
}

function createTunnel(uploader, downloader, pFile) {
  var tunId = makeTunnelId();
  tunnels[tunId] = {
    buffer: [],
    uploader: uploader,
    downloader: downloader,
    file: pFile,
  };
  return tunId;
}
