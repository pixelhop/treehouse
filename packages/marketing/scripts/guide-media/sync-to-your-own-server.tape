# vhs sync-to-your-own-server.tape (from this folder, with REPO, GUIDE_MEDIA_HOME set
# and `node scenes.mjs approve` running in another terminal)
Output "raw/sync-to-your-own-server.mp4"
Set Shell "bash"
Set FontSize 24
Set Width 1400
Set Height 820
Set Padding 36
Set TypingSpeed 35ms
Set Theme { "name": "treehouse", "black": "#2b2a26", "red": "#b4533b", "green": "#3f7d58", "yellow": "#a07a2c", "blue": "#3f6f8f", "magenta": "#8a5a83", "cyan": "#3f7d7d", "white": "#e9e4d6", "brightBlack": "#7d776a", "brightRed": "#c4664d", "brightGreen": "#4f9a6c", "brightYellow": "#b78f3d", "brightBlue": "#4f82a4", "brightMagenta": "#9e6c97", "brightCyan": "#4f9393", "brightWhite": "#f7f4ec", "background": "#fbf8f1", "foreground": "#2b2a26", "selection": "#e2dccb", "cursor": "#3f7d58" }
Hide
Type "source terminal.rc.sh"
Enter
Sleep 500ms
Show
Type "# Connect a folder to a Treehouse server running on this laptop"
Enter
Sleep 600ms
Type "treehouse login ~/Vaults/Acme --api-base http://localhost:3110 --no-start"
Enter
Sleep 6s
Type "treehouse sync ~/Vaults/Acme"
Enter
Sleep 3s
Type "ls ~/Vaults/Acme"
Enter
Sleep 2s
Type "echo '- Dana confirmed 4 November.' >> ~/Vaults/Acme/Clients/Northwind/README.md"
Enter
Sleep 600ms
Type "treehouse sync ~/Vaults/Acme"
Enter
Sleep 3500ms
