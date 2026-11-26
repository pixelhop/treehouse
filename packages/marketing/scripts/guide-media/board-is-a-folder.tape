# vhs board-is-a-folder.tape (from this folder, with REPO, GUIDE_MEDIA_HOME set
# after sync-to-your-own-server.tape)
Output "raw/board-is-a-folder.mp4"
Set Shell "bash"
Set FontSize 24
Set Width 1400
Set Height 820
Set Padding 36
Set TypingSpeed 35ms
Set Theme { "name": "treehouse", "black": "#2b2a26", "red": "#b4533b", "green": "#3f7d58", "yellow": "#a07a2c", "blue": "#3f6f8f", "magenta": "#8a5a83", "cyan": "#3f7d7d", "white": "#e9e4d6", "brightBlack": "#7d776a", "brightRed": "#c4664d", "brightGreen": "#4f9a6c", "brightYellow": "#b78f3d", "brightBlue": "#4f82a4", "brightMagenta": "#9e6c97", "brightCyan": "#4f9393", "brightWhite": "#f7f4ec", "background": "#fbf8f1", "foreground": "#2b2a26", "selection": "#e2dccb", "cursor": "#3f7d58" }
Hide
Type "source terminal.rc.sh; cd ~/Vaults/Acme; clear"
Enter
Sleep 500ms
Show
Type "# The board is a folder. Each card is a Markdown file."
Enter
Sleep 600ms
Type "ls 'Projects/Website relaunch/Tasks'"
Enter
Sleep 1800ms
Type "cat 'Projects/Website relaunch/Tasks/pricing-page.md'"
Enter
Sleep 2500ms
Type "grep -rl 'status: Doing' Projects"
Enter
Sleep 3s
