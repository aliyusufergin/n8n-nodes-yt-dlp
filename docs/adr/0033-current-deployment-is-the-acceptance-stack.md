---
status: accepted
---

# Birinci sınıf kabul stack'i mevcut exact deployment'ı izler

ADR 0032'nin birinci sınıf gerçek kabul stack'i için sabitlediği n8n 2.27.4 kimliği,
sunucuda yalnız o sürüm o sırada çalıştığı için seçilmişti; bu kimlik artık mevcut deployment'ı
temsil etmediğinden yalnız bu dar kabul lane'i için superseded edilmiştir. Gerçek kabul stack'i
mevcut exact deployment'ı izler ve bugün n8n 2.34.5 ile exact official image
`docker.n8n.io/n8nio/n8n@sha256:d91033b4fac2f7b75c5c4007e10824c66147f7d7a3cccb488720e97452ee7dc7`
olarak doğrulanır; mutable `stable` etiketi kanıt sayılmaz. ADR 0025'in disposable üç-anchor
Release Gate Matrix'i ve daha önce üretilmiş version-bound araştırma/E2E kanıtları değişmeden kalır;
bu karar yalnız mevcut stack'te ayrıca onaylanan dar acceptance işleminin kimliğini günceller.

Instance mutable `stable` etiketiyle koştuğu için sürüm operatör müdahalesi olmadan ilerleyebilir.
Kimlik bu yüzden her kabul koşusunda çalışan digest'ten yeniden çözülür ve bu ADR ile senkron
tutulur. Kimlik 2026-08-12'de 2.32.7'den (`sha256:882b126a…46e2`) 2.34.5'e taşındı; sürüm otomatik
güncellemeyle ilerlemişti. Önceki kimlik altında üretilmiş kanıtlar o sürüme bağlı kalır ve yeni
pin altında yeniden koşulmadıkça gate kanıtı sayılmaz.
