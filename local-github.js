var restify = require('restify');
var Git = require("nodegit");
var fs = require('fs');
var crypto = require('crypto');

var axios = require('axios');

var config = JSON.parse(fs.readFileSync('config.json'));

function notImplemented(req, res, next) {
  console.log("unimplemented", req.method, req.url, req.params, req.body);
  res.send(404, "");
  next();
}

function getUser(req, res, next) {
  var user = "rcbuild.info-dev";
  if (req.query.access_token.search("-access-token") > -1) {
    user = req.query.access_token.replace("-access-token", "");
  }
  res.header('etag', 'ignored');
  res.header('last-modified', 0);
  res.header('cache-control', 'private');
  res.send({"login": user});
  next(false);
}

function getContents(req, res, next) {
  var commit = null;
  var repo = null;
  Git.Repository.open("repos/" + req.params.user + "/" + req.params.repo)
                .then(function(r) {
                  repo = r;
                  if (req.params.ref &&
                      req.params.ref.search("refs/heads/") === -1) {
                    return Git.Commit.lookupPrefix(repo, Git.Oid.fromString(req.params.ref), req.params.ref.length);
                  }
                  var ref = "refs/heads/master";
                  if (req.params.ref) {
                    ref = req.params.ref;
                  }
                  return repo.getReferenceCommit(ref);
                })
                .then(function(c) {
                  commit = c;
                  c.repo = repo;
                  return c.getTree();
                })
                .then(function(tree) {
                  return tree.getEntry(req.params.filename);
                })
                .then(function(treeEntry) {
                  return treeEntry.getBlob();
                })
                .then(function(blob) {
                  res.writeHead(200, {'content-length': blob.rawsize(),
                                      'content-type': 'application/json',
                                      'etag': commit.sha(),
                                      'last-modified': commit.time(),
                                      'cache-control': 'private'});

                  res.write(blob.content());
                  res.end();
                  next(false);
                }).catch(
                  function(reason) {
                    console.log(reason);
                    res.writeHead(404, {'content-length': 0,
                                        'cache-control': 'private'});
                    res.end();
                    next(false);
                  }
                );
}

function createReference(req, res, next) {
  Git.Repository.open("repos/" + req.params.user + "/" + req.params.repo)
                .then(function(repo) {
                  if (req.body.ref.search("refs/heads/") === 0) {
                    return repo.createBranch(req.body.ref.replace("refs/heads", ""), req.body.sha, false, Git.Signature.default(repo), "");
                  }
                })
                .then(function(ref) {
                  res.send(201, {});
                  next(false);
                })
                .catch(function(reason) {
                  res.send(404, reason);
                  next(false);
                });
}

function getReference(req, res, next) {
  Git.Repository.open("repos/" + req.params.user + "/" + req.params.repo)
                .then(function(repo) {
                  return repo.getReferenceCommit("refs/heads/" + req.params.branch);
                })
                .then(function(commit) {
                  res.send(200, {"ref": "refs/heads/" + req.params.branch,
                  "object": {"type": "commit", "sha": commit.sha()}});
                  next(false);
                })
                .catch(function(reason) {
                  console.log("error stack", reason.stack);
                  res.send(404, {});
                  next(false);
                });
}

function runWebhooks(repo, event, payload) {
  var hookFilename = repo.path().replace("/.git/", "") + "/hooks.json";
  fs.readFile(hookFilename,
    function (err, data) {
      var currentHooks = [];
      if (err && err.code != 'ENOENT') {
        throw err;
      } else if (!err) {
        currentHooks = JSON.parse(data);
      }
      for (var i = 0; i < currentHooks.length; i++) {
        var hook = currentHooks[i];
        if (hook.name !== "web") {
          console.log("only webhooks supported");
          continue;
        }
        if (hook.config.content_type != "json") {
          console.log("only json content supported");
          continue;
        }
        if (!hook.active || !(event in hook.events)) {
          continue;
        }
        var stringPayload = JSON.stringify(payload);
        var hmac = crypto.createHmac("sha1", hook.config.secret);
        hmac.update(stringPayload);
        axios.post(hook.config.url, stringPayload, {"headers": {"X-Hub-Signature": "sha1=" + hmac.digest("hex")}});
      }
    });
}

function changeReference(req, res, next) {
  var lastHead;
  var head;
  var repo;
  Git.Repository.open("repos/" + req.params.user + "/" + req.params.repo)
                .then(function(r) {
                  repo = r;
                  return repo.getReference("refs/heads/" + req.params.branch);
                })
                .then(function(reference) {
                  lastHead = reference.target();
                  return reference.setTarget(req.params.sha, "Update HEAD");
                })
                .then(function(reference) {
                  res.send(200, {});
                  next(false);

                  return Promise.all([Git.Commit.lookup(repo, lastHead),
                                      Git.Commit.lookup(repo, req.params.sha)]);
                })
                .then(function(commits) {
                  var promises = [];
                  for (var i in commits) {
                    promises.push(commits[i].getTree());
                  }
                  head = commits[commits.length - 1];
                  return Promise.all(promises);
                })
                .then(function(trees) {
                  return Git.Diff.treeToTree(repo, trees[0], trees[1]);
                })
                .then(function(diff) {
                  var commit = {"id": req.params.sha,
                                "timestamp": head.date().toISOString(),
                                "modified": [],
                                "added": [],
                                "deleted": []};
                  for (var i = 0; i < diff.numDeltas(); i++) {
                    var d = diff.getDelta(i);
                    if (d.status() === Git.Diff.DELTA.MODIFIED) {
                      commit["modified"].push(d.newFile().path());
                    } else if (d.status() === Git.Diff.DELTA.ADDED) {
                      commit["added"].push(d.newFile().path());
                    } else if (d.status() === Git.Diff.DELTA.DELETED) {
                      commit["deleted"].push(d.newFile().path());
                    }
                  }
                  runWebhooks(repo,
                              "push",
                              {"repository": {"owner": {"name": req.params.user}},
                               "ref": "refs/heads/" + req.params.branch,
                               "before": lastHead.tostrS(),
                               "commits": [commit]});
                })
                .catch(function(reason) {
                  console.log("error stack", reason.stack);
                  res.send(404, {});
                  next(false);
                });
}

function postCommitHook(req, res, next) {
  var lastHead;
  var head;
  var repo;
  Git.Repository.open("repos/" + req.params.user + "/" + req.params.repo)
                .then(function(r) {
                  repo = r;
                  return Git.Commit.lookup(repo, req.params.sha);
                })
                .then(function(headCommit) {
                  head = headCommit;
                  return headCommit.parent(0);
                })
                .then(function(parentCommit) {
                  parentCommit.repo = repo;
                  lastHead = parentCommit.id();
                  return Promise.all([parentCommit.getTree(), head.getTree()]);
                })
                .then(function(trees) {
                  return Git.Diff.treeToTree(repo, trees[0], trees[1]);
                })
                .then(function(diff) {
                  var commit = {"id": req.params.sha,
                                "timestamp": head.date().toISOString(),
                                "modified": [],
                                "added": [],
                                "deleted": []};
                  for (var i = 0; i < diff.numDeltas(); i++) {
                    var d = diff.getDelta(i);
                    if (d.status() === Git.Diff.DELTA.MODIFIED) {
                      commit["modified"].push(d.newFile().path());
                    } else if (d.status() === Git.Diff.DELTA.ADDED) {
                      commit["added"].push(d.newFile().path());
                    } else if (d.status() === Git.Diff.DELTA.DELETED) {
                      commit["deleted"].push(d.newFile().path());
                    }
                  }
                  runWebhooks(repo,
                              "push",
                              {"repository": {"owner": {"name": req.params.user}},
                               "ref": "refs/heads/" + req.params.branch,
                               "before": lastHead.tostrS(),
                               "commits": [commit]});
                  res.header("Content-Type", "text/plain");
                  res.send(200, "");
                  next(false);
                })
                .catch(function(reason) {
                  console.log("error stack", reason.stack);
                  res.send(404, {});
                  next(false);
                });
}

function getCommit(req, res, next) {
  Git.Repository.open("repos/" + req.params.user + "/" + req.params.repo)
                .then(function(repo) {
                  return repo.getCommit(req.params.sha);
                })
                .then(function(commit) {
                  res.send(200, {"tree": {"sha": commit.treeId().tostrS()}});
                  next(false);
                })
                .catch(function(reason) {
                  console.log("error stack", reason.stack);
                  res.send(404, {});
                  next(false);
                });
}

function createCommit(req, res, next) {
  Git.Repository.open("repos/" + req.params.user + "/" + req.params.repo)
                .then(function(repo) {
                  return repo.createCommit(null, Git.Signature.default(repo), Git.Signature.default(repo), req.body.message, req.body.tree, req.body.parents);
                })
                .then(function(oid) {
                  res.send(201, {"sha": oid.tostrS()});
                  next(false);
                })
                .catch(function(reason) {
                  console.log("error stack", reason.stack);
                  res.send(404, {});
                  next(false);
                });
}

function createTree(req, res, next) {
  var repo;
  var builder;
  Git.Repository.open("repos/" + req.params.user + "/" + req.params.repo)
                .then(function(r) {
                  repo = r;
                  return Git.Tree.lookup(repo, req.body.base_tree);
                })
                .then(function(baseTree) {
                  return Git.Treebuilder.create(baseTree.repo, baseTree);
                })
                .then(function(b) {
                  builder = b;
                  var allPromises = [];
                  for (var i = 0; i < req.body.tree.length; i++) {
                    var e = req.body.tree[i];
                    var oid;
                    if (e.type === "blob") {
                      oid = repo.createBlobFromBuffer(new Buffer(e.content));
                    }
                    allPromises.push(builder.insert(e.path, oid, parseInt(e.mode, 8)));
                  }
                  return Promise.all(allPromises);
                })
                .then(function(entries) {
                   var oid = builder.write();
                   res.send(201, {"sha": oid.tostrS()});
                   next(false);
                 })
                .catch(function(reason) {
                  console.log("error stack", reason.stack);
                  res.send(404, {});
                  next(false);
                });
}

function getHook(req, res, next) {
  var hookFilename = "repos/" + req.params.user + "/" + req.params.repo + "/hooks.json";
  fs.readFile(hookFilename,
    function (err, data) {
      var currentHooks = [];
      if (err && err.code != 'ENOENT') {
        throw err;
      } else if (!err) {
        currentHooks = JSON.parse(data);
      }
      res.send(currentHooks);
      next(false);
    });
}

function setHook(req, res, next) {
  Git.Repository.open("repos/" + req.params.user + "/" + req.params.repo)
    .then(function(repo) {
      var hookFilename = "repos/" + req.params.user + "/" + req.params.repo + "/hooks.json";
      fs.readFile(hookFilename,
        function (err, data) {
          var currentHooks = [];
          if (err && err.code != 'ENOENT') {
            throw err;
          } else if (!err) {
            currentHooks = JSON.parse(data);
          }
          var newHook = req.body;
          if (currentHooks.length === 0) {
            newHook.id = 0;
          } else {
            newHook.id = currentHooks[currentHooks.length - 1].id + 1;
          }
          for (var i = 0; i < currentHooks.length; i++) {
            if (JSON.stringify(newHook.config) === JSON.stringify(currentHooks[i].config)) {
              res.send(201, currentHooks[i]);
              next(false);
              return;
            }
          }
          currentHooks.push(newHook);
          fs.writeFileSync(hookFilename, JSON.stringify(currentHooks,  null, 2));
          res.send(201, newHook);
          next(false);
        });
    })
    .catch(function(reason) {
      res.send(404, reason);
      next(false);
    });
}

function addFork(req, res, next) {
  var forkingUser = req.params.access_token.replace("-access-token", "");
  res.send(202, {"default_branch": "not_master"});
  next(false);
  Git.Clone.clone("file://" + process.cwd() + "/repos/" + req.params.user + "/" + req.params.repo, "repos/" + forkingUser + "/" + req.params.repo)
           .then(function(repo) {
             // Add a hook shell script so we get called back even when files are committed through the git command line.
             fs.writeFileSync("repos/" + forkingUser + "/" + req.params.repo + "/.git/hooks/post-commit",
             "curl \"http://localhost:6178/hook/post-commit?sha=`git log -1 --format=format:%H`&user=" + req.params.user + "&repo=" + req.params.repo + "\"", {mode: 0777});
           });
}

function login(req, res, next) {
  var body = fs.readFileSync("login.html");
  res.writeHead(200, {
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'text/html'
  });
  res.write(body);
  res.end();
  next(false);
}

function redirectLocation(req, res, next) {
  var redirectLocation = "var redirectLocation = \"" + config.oauthCallback + "\";\n";
  res.writeHead(200, {
    'Content-Length': redirectLocation.length,
    'Content-Type': 'text/javascript'
  });
  res.write(redirectLocation);
  res.end();
  next(false);
}

function accessToken(req, res, next) {
  res.header("Content-Type", "application/x-www-form-urlencoded");
  if (req.params.code.search("error") == 0) {
    res.send("error=" + req.params.code.slice("error".length));
  } else {
    res.send("access_token=" + req.params.code.replace("code", "token"));
  }
  next(false);
}

function printRequest(req, res, next) {
  console.log(req.method, req.path());
  return next();
}

var server = restify.createServer();
server.use(printRequest);
server.use(restify.queryParser());
server.use(restify.bodyParser());
server.get("/repos/:user/:repo/contents/:filename", getContents);
server.post("/repos/:user/:repo/forks", addFork);
server.get("/repos/:user/:repo/hooks", getHook);
server.post("/repos/:user/:repo/hooks", setHook);
server.post("/repos/:user/:repo/git/refs", createReference);
server.get("/repos/:user/:repo/git/refs/heads/:branch", getReference);
server.post("/repos/:user/:repo/git/refs/heads/:branch", changeReference);
server.get("/repos/:user/:repo/git/commits/:sha", getCommit);
server.post("/repos/:user/:repo/git/commits", createCommit);
server.post("/repos/:user/:repo/git/trees", createTree);
server.get("/user", getUser);

// Oauth calls
server.post("/login/oauth/access_token", accessToken);
server.get("/login/oauth/authorize", login);
server.get("/redirectLocation.js", redirectLocation);

// git hook so we can call our webhooks. We will not trigger these when we commit.
server.get("/hook/post-commit", postCommitHook);

// Catch alls
server.get(/.*/, notImplemented);
server.post(/.*/, notImplemented);

server.listen(6178, function() {
  console.log('%s listening at %s', server.name, server.url);
});
