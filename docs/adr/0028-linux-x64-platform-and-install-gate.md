---
status: accepted
---

# V0.2.0 Linux x64 Platform Gate ile fail-closed çalışır

Ana paket, Platform Selector ve Linux x64 Platform Paketi `os: ["linux"]` ve `cpu: ["x64"]` metadata'sı taşıyacak; bu sürümde arm64, Windows veya macOS platform paketi yayımlanmayacaktır. `libc` alanı exact tool ABI ve npm algılama davranışı kanıtlanmadan kullanılmayacak; alan resmî n8n image'ının tam uyumluluk ortamını veya kimliğini temsil etmez. Npm metadata erken install gate olsa da tek güvenlik sınırı değildir: selector her spawn öncesi Linux/x64 hostu, exact platform paketini, beklenen manifest/digest'leri ve executable probe'larını doğrulayacak; `PATH`, host yt-dlp/FFmpeg/Deno, runtime download veya permission repair fallback'i olmayacaktır. Doğrulanmış Destek yalnız resmî n8n Docker Linux x64'tür. Linux arm64, Windows, macOS, n8n Cloud, bare-metal/npm kurulumları, alternatif container base'leri ve diğer Linux x64 ortamlar v0.2.0'da destek dışı ve doğrulanmamıştır; uyumlu bir gayriresmî ortamda çalışmak destek matrisini genişletmez. Unsupported platform ve eksik/bozuk toolchain global invariant hatasıdır. N8n'in shallow installer'ında metadata reddi ve resolver fail-closed davranışı exact tarball E2E geçmeden kanıtlanmış sayılmaz.
