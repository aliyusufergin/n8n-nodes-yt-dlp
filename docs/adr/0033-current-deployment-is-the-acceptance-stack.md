---
status: accepted
---

# Birinci sınıf kabul stack'i mevcut exact deployment'ı izler

ADR 0032'nin birinci sınıf gerçek kabul stack'i için sabitlediği n8n 2.27.4 kimliği,
sunucuda yalnız o sürüm o sırada çalıştığı için seçilmişti; bu kimlik artık mevcut deployment'ı
temsil etmediğinden yalnız bu dar kabul lane'i için superseded edilmiştir. Gerçek kabul stack'i
n8n 2.32.7 ve exact official image
`docker.n8n.io/n8nio/n8n@sha256:882b126a8ddd0646e7d17ec47630e7704615e4647f3363471859fddc3f8946e2`
olarak doğrulanacak; mutable `stable` etiketi kanıt sayılmayacaktır. ADR 0025'in disposable üç-anchor
Release Gate Matrix'i ve daha önce üretilmiş version-bound araştırma/E2E kanıtları değişmeden kalır;
bu karar yalnız mevcut stack'te ayrıca onaylanan dar acceptance işleminin kimliğini günceller.
