#!/usr/bin/env node
/*
 * Pulley-GitLab: Easy GitLab Merge Request Lander
 * Copyright 2011 John Resig
 * Updated for GitLab 2012 Charles Phillips
 * MIT Licensed
 */
(function() {
	"use strict";

	var child = require("child_process"),
		http = require("https"),
		fs = require("fs"),
		prompt = require("prompt"),
		request = require("request"),
		colors = require("colors"),

		// Process references
		exec = child.exec,
		spawn = child.spawn,

		// Process arguments
		id = process.argv[ 2 ],
		done = process.argv[ 3 ],

		// Localized application references
		gitlab_server = "",
		project_code = "",
		tracker = "",
		token = "",

		// Initialize config file
		config = JSON.parse( fs.readFileSync( process.env.PWD + "/pulley-gitlab.json" ) );

	// We don't want the default prompt message
	prompt.message = "";

	process.stdout.write( "Initializing... ".blue );

	gitlab_server = config.server.trim();
	if ( gitlab_server ) {
		check_token();
	} else {
		exit("Please set gitlab server in ./pulley-config.json");
	}

	function check_token() {
		exec( "git config --get pulley-gitlab.token", function( error, stdout, stderr ) {
			token = stdout.trim();

			if ( token ) {
				init();
			} else {
				login();
			}
		});
	}

	function login() {
		console.log("\nPlease login with your GitLab credentials.");
		console.log("Your credentials are only needed this one time to get a token from GitLab.");
		prompt.start();
		prompt.get([{
			name: "email",
			message: "Email",
			empty: false
		}, {
			name: "password",
			message: "Password",
			empty: false,
			hidden: true
		}], function( err, result ) {
			request.post(gitlab_server + "/api/v2/session", {
				json: true,
				body: {
					email: result.email,
					password: result.password
				}
			}, function( err, res, body ) {
				token = body.private_token;
				if ( token ) {
					exec( "git config --add pulley-gitlab.token " + token, function( error, stdout, stderr ) {
						console.log( "Success!".green );
						init();
					});
				} else {
					console.log( ( body.message + ". Try again." ).red );
					login();
				}
			});
		});
	}

	function init() {
		if ( !id ) {
			exit("No pull request ID specified, please provide one.");
		}
		exec( "git remote -v show " + config.remote, function( error, stdout, stderr ) {
			project_code = ( /URL:.*?[\w\-\/]+:?([\w\-]+)(?=\.git)/.exec( stdout ) || [] )[ 1 ];
			tracker = config.repos[ project_code ];

			if ( project_code ) {
				getStatus();
			} else {
				exit("External repository not found.");
			}
		});
	}

	function getStatus() {
		exec( "git status", function( error, stdout, stderr ) {
			if ( /Changes to be committed/i.test( stdout ) ) {
				if ( done ) {
					getPullData();
				} else {
					exit("Please commit changed files before attemping a pull/merge.");
				}
			} else if ( /Changes not staged for commit/i.test( stdout ) ) {
				if ( done ) {
					exit("Please add files that you wish to commit.");

				} else {
					exit("Please stash files before attempting a pull/merge.");
				}
			} else {
				if ( done ) {
					exit("It looks like you've broken your merge attempt.");
				} else {
					getPullData();
				}
			}
		});
	}

	function getPullData() {
		var path = "projects/" + project_code + "/merge_request/" + id;

		console.log( "done.".green );
		process.stdout.write( "Getting pull request details... ".blue );

		callAPI( path, function( data ) {
			try {
				var pull = JSON.parse( data );

				console.log( "done.".green );

				if ( done ) {
					commit( pull );
				} else {
					mergePull( pull );
				}
			} catch( e ) {
				exit("Error retrieving pull request from GitLab.");
			}
		});
	}

	function mergePull( pull ) {
		var source_branch = pull.source_branch,
			target_branch = pull.target_branch,
			branch = "pull-" + id,
			checkout = "git checkout " + target_branch,
			checkout_cmds = [
				checkout,
				"git pull " + config.remote + " " + target_branch,
				"git submodule update --init",
				"git checkout -b " + branch
			];

		process.stdout.write( "Pulling and merging results... ".blue );

		if ( pull.closed ) {
			exit("Can not merge closed Merge Requests.");
		}

		if ( pull.merged ) {
			exit("This Merge Request has already been merged.");
		}

		// TODO: give user the option to resolve the merge by themselves
		if ( pull.state !== 2 ) {
			exit("This Merge Request is not automatically mergeable.");
		}

		exec( checkout_cmds.join( " && " ), function( error, stdout, stderr ) {
			if ( /toplevel/i.test( stderr ) ) {
				exit("Please call pulley from the toplevel directory of this repo.");
			} else if ( /fatal/i.test( stderr ) ) {
				exec( "git branch -D " + branch + " && " + checkout, doPull );
			} else {
				doPull();
			}
		});

		function doPull( error, stdout, stderr ) {
			var pull_cmds = [
				"git pull " + config.remote + " " + source_branch,
				checkout,
				"git merge --no-commit --squash " + branch
			];

			exec( pull_cmds.join( " && " ), function( error, stdout, stderr ) {
				if ( /Merge conflict/i.test( stdout ) ) {
					exit("Merge conflict. Please resolve then run: " +
						process.argv.join(" ") + " done");
				} else if ( /error/.test( stderr ) ) {
					exit("Unable to merge.  Please resolve then retry:\n" + stderr);
				} else {
					console.log( "done.".green );
					commit( pull );
				}
			});
		}
	}

	function commit( pull ) {
		var path = "projects/" + project_code + "/merge_request/" + id + "/commits";

		process.stdout.write( "Getting author and committing changes... ".blue );

		callAPI( path, function( data ) {
			var match,
				msg = "Close GL-" + id + ": " + pull.title + ".",
				commits = JSON.parse( data ),
				author = commits[ 0 ].author_name,
				target_branch = pull.target_branch,
				titles = " ",
				issues = [],
				urls = [],
				findBug = /#(\d+)/g;

			// Search title and commit titles for issues for issues to link to
			for (var i in commits) {
				titles += commits[i].title + " "
			}
			if ( tracker ) {
				while ( ( match = findBug.exec( pull.title + titles ) ) ) {
					urls.push( tracker + match[ 1 ] );
				}
			}

			// Search just commit titles to add to the commit message
			while ( ( match = findBug.exec( titles ) ) ) {
				issues.push( " Fixes #" + match[ 1 ] );
			}

			// Add issues to the commit message
			msg += issues.join(",");

			if ( urls.length ) {
				msg += "\n\nMore Details:" + urls.map(function( url ) {
					return "\n - " + url;
				}).join("");
			}

			var commit = [ "commit", "-a", "--message=" + msg ];

			if ( config.interactive ) {
				commit.push("-e");
			}

			if ( author ) {
				commit.push( "--author=" + author );
			}

			getHEAD(function( oldCommit ) {
				// Thanks to: https://gist.github.com/927052
				spawn( "git", commit, {
					customFds: [ process.stdin, process.stdout, process.stderr ]
				}).on( "exit", function() {
					getHEAD(function( newCommit ) {
						if ( oldCommit === newCommit ) {
							exit("No commit, aborting push.");
						} else {
							exec( "git push " + config.remote + " " + target_branch, function( error, stdout, stderr ) {
								console.log( "done.".green );
								exit();
							});
						}
					});
				});
			});
		});
	}

	function callAPI( path, callback ) {
		request.get( gitlab_server + "/api/v2/" + path, {
			headers: {
				"private-token": token
			}
		}, function( err, res, body ) {
			var statusCode = res.socket._httpMessage.res.statusCode;

			if ( err ) {
				exit( err );
			}

			if ( statusCode === 404 ) {
				exit("Merge Request doesn't exist");
			}

			if ( statusCode === 401 ) {
				login();
				return;
			}

			callback( body );
		});
	}

	function getHEAD( fn ) {
		exec( "git log | head -1", function( error, stdout, stderr ) {
			var commit = ( /commit (.*)/.exec( stdout ) || [] )[ 1 ];

			fn( commit );
		});
	}

	function reset( msg ) {
		console.error( ( "\n" + msg ).red );
		process.stderr.write( "Resetting files... ".red );

		exec( "git reset --hard ORIG_HEAD", function() {
			console.log( "done.".green );
			exit();
		});
	}

	function exit( msg ) {
		if ( msg ) {
			console.error( ( "\nError: " + msg ).red );
		}

		process.exit( 1 );
	}

})();