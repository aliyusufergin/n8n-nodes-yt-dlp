---
status: accepted
---

# Worker-local workspace finally cleanup ve doğrulanmış stale sweep kullanır

İlk sürüm `${os.tmpdir()}/n8n-nodes-yt-dlp` altında current UID'ye ait, gerçek ve `0700` bir taban ile random Execution Workspace kullanır; paylaşılan `.n8n` volume'una geçici indirme yazmaz. Normal completion, hata, timeout, cancellation ve binary transfer failure sonrasında Process Group ile stream'ler kapandıktan sonra request workspace bounded retry ile `finally` içinde silinir; güncel workspace temizlenemezse `WORKSPACE_CLEANUP_FAILED` global hatası oluşur ve `Continue On Fail` uygulanmaz. Versioned, secretsiz owner marker en fazla dakikada bir heartbeat alır. Her sonraki node execution başlangıcında exact package prefix'li direct child'lardan marker heartbeat'i üç saatten eski olan en fazla 100 kök; real directory, current UID, symlink içermeyen yol ve regular/single-link/owner-only marker koşulları doğrulandıktan sonra silinir. Belirsiz girdiye dokunulmaz; doğrulanmış stale root silinemezse `STALE_WORKSPACE_CLEANUP_FAILED` oluşur. SIGKILL/OOM sonrası anlık cleanup garanti edilmez; node tekrar çalışmazsa operatör yalnız ilgili container'ı recreate eder, genel prune kullanmaz.
