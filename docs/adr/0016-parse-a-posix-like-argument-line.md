# Parse a POSIX-like argument line

The node will parse a lexical POSIX-like subset supporting whitespace, line breaks, quoting, escaping, line continuation, repeated ordered options, and `--`, but it will perform no shell expansions and will reject shell operators and the executable name itself. Both ordinary and sensitive argument lines will use this parser before semantic restrictions are applied, giving familiar CLI quoting without invoking or emulating a shell.
