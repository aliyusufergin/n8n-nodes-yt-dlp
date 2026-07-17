---
status: accepted
---

# Arguments bağımlılıksız dar bir lexer ile token'laştırılır

İlk sürüm whitespace, tek/çift quote, tırnaksız ve çift tırnaklı backslash escape, bitişik quoted/unquoted parça birleştirmesi ve boş quoted token destekleyen özel Arguments Grammar kullanacak. Environment/command/tilde/brace/glob expansion, comment, shell operatorü, multiline, `--` terminator, positional, kısa option cluster'ı ve attached kısa değer desteklenmeyecek; yalnızca `--option=value`, `--option value` ve allowlist'teki tekil kısa alias biçimleri parse edilecektir. 16 KiB satır, 256 token ve 8 KiB token limitleri uygulanacak; syntax hatası child process başlamadan bildirilecek ve lexer tablo, round-trip, property ve fuzz testleriyle release gate olacaktır.
