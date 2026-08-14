---
status: accepted
---

# PR doğrulama kapısı ucuzdur, zorunludur ve yayın gate'lerinden ayrıdır

`main`'e giden her pull request `typecheck`, `lint` ve `test` komutlarını
`.github/workflows/pr-verification.yml` içindeki tek bir `verify` job'ında koşar; bu check
`main` branch protection'ında zorunludur. Kapı bilinçli olarak ucuzdur: `test:e2e:*` lane'leri
Docker, pinlenmiş image ve dakikalar gerektirdiği için ADR 0025, 0030 ve 0032'nin yayın
gate'lerinde kalır ve bu kararla değişmez. `publish.yml` ile `recover-bootstrap.yml` yalnız
`workflow_dispatch` ile çalışmaya devam eder.

Kapının yayın sırlarına erişimi yoktur: `permissions` yalnız `contents: read` verir, workflow
hiçbir `environment` ya da `id-token` bildirmez. Böylece herhangi bir branch'ten açılan pull
request yayın kimlik bilgilerine ulaşamaz. Node sürümü yayın workflow'larıyla aynı değere
(24.16.0) pinlenir ve bağımlılıklar `npm ci` ile kurulur.

`timeout-minutes: 30` bilinçli olarak geniştir. Suite'in neredeyse tamamı
`test/release-candidate.test.ts` içinde geçer: build, üç paket için `npm pack` ve 187 MB
tarball'ın 7-Zip `-mx=9` ile yeniden sıkıştırılması. Dar bir bütçe kapıyı kendi kendine flaky
yapar ve kapının değerini yok eder.

`enforce_admins` kapalıdır: repository sahibi manuel bir kaçış yolu tutar. Kapı bu yüzden
başkalarını değil, akışın kendisini korur — kırmızı bir suite üstüne kaza eseri merge etmeyi
imkânsız kılar, kasıtlı bir sahibi durdurmaz. Bu, sahibin açık kararıdır; kapının kırmızıda
gerçekten merge'ü reddettiği, `enforce_admins` geçici olarak açıkken merge API'sinin
reddetmesiyle kanıtlanmıştır (`docs/ci.md`). `strict` kapalıdır çünkü her merge öncesi rebase
zorunluluğu birkaç dakikalık suite'i yeniden koşturur ve kapattığı yarış bu maliyeti hak etmez.
