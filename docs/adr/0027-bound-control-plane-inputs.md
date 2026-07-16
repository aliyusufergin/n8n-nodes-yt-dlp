# Bound control-plane inputs

The node will limit the normal Arguments and Sensitive Arguments fields to 64 KiB of UTF-8 each and Netscape cookie content to 10 MiB of UTF-8. Text inputs containing a NUL byte will fail, and cookie syntax will be validated before process creation. Size and syntax errors will identify the field, byte count or line, and constraint without reproducing secret content. These fixed v1 limits do not impose an artifact-size or playlist-entry ceiling; they bound only configuration parsing, credential memory, redaction work, and process argv.
