-- Starts the bundled export server (if not already running) and opens the app window.
set appRoot to POSIX path of (path to me) & "Contents/Resources/app"
set appUrl to "http://127.0.0.1:47823"

on serverUp()
	try
		do shell script "curl -sf -o /dev/null --max-time 1 http://127.0.0.1:47823/api/ping"
		return true
	on error
		return false
	end try
end serverUp

if not serverUp() then
	try
		-- Apps opened from Finder don't get the shell PATH, so check the usual install locations and use the first Node that runs.
		set nodeBin to do shell script "for n in /opt/homebrew/bin/node /usr/local/bin/node $(ls -d \"$HOME\"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V -r) \"$HOME\"/.volta/bin/node; do [ -x \"$n\" ] && \"$n\" -v >/dev/null 2>&1 && { echo \"$n\"; exit 0; }; done; /bin/zsh -ilc 'command -v node' 2>/dev/null | tail -1 | grep . || exit 1"
	on error
		display alert "Node.js is required" message "Install Node.js (nodejs.org or `brew install node`), then open Paper to PSD again."
		return
	end try
	-- Redirect the whole backgrounded group, or do shell script waits for the server to exit.
	do shell script "(cd " & quoted form of appRoot & " && exec nohup " & quoted form of nodeBin & " server.mjs) > /tmp/paper-to-psd.log 2>&1 < /dev/null &"
	repeat 40 times
		if serverUp() then exit repeat
		delay 0.25
	end repeat
	if not serverUp() then
		display alert "Paper to PSD couldn't start" message "See /tmp/paper-to-psd.log for details."
		return
	end if
end if

-- Open in the default browser; Chromium-based ones get a chromeless app window.
try
	set browserPath to do shell script "osascript -l JavaScript -e 'ObjC.import(\"AppKit\"); $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString(\"https://example.com\")).path.js'"
on error
	set browserPath to ""
end try
set chromium to {"Google Chrome", "Brave Browser", "Microsoft Edge", "Arc", "Vivaldi", "Chromium", "Opera"}
repeat with b in chromium
	if browserPath ends with ((b as text) & ".app") then
		do shell script "open -na " & quoted form of browserPath & " --args --app=" & appUrl & " --window-size=1120,780 > /dev/null 2>&1 &"
		return
	end if
end repeat
do shell script "open " & appUrl
