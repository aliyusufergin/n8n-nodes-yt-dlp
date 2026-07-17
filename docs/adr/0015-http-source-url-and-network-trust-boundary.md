---
status: accepted
---

# Source URL yalnızca mutlak HTTP(S)'dir

İlk sürüm her input item'da Arguments'tan ayrı, WHATWG URL parser ile doğrulanan, userinfo ve control character içermeyen, en fazla 16 KiB UTF-8 uzunluğunda mutlak `http:` veya `https:` Source URL kabul edecek. Local/data/stream şemaları, search prefix'leri, çıplak arama, batch/stdin listesi, local info JSON ve URL/extractor sınırını değiştiren CLI seçenekleri reddedilecek; varsayılan extractor seçimi korunacaktır. Node, extractor/redirect/DNS/manifest/FFmpeg trafiği üzerinde SSRF güvenlik sınırı iddia etmeyecek, v1'de AI tool olmayacak ve güvenilmeyen URL girdisi için egress firewall/proxy allowlist'ini operatör sorumluluğu olarak belgeleyecektir.
