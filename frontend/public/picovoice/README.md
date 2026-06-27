# Wake-word "Ehy HQ" — file Picovoice

La chatbox HQ ascolta la wake-word **on-device** con Picovoice Porcupine.
Per attivarla servono **una access key** + **due file modello** in questa cartella.
Senza questi, la wake-word resta semplicemente spenta (il microfono manuale funziona lo stesso).

## 1. Access key (gratis)
1. Crea un account su https://console.picovoice.ai
2. Copia la **AccessKey** dalla dashboard
3. Su Render, nel servizio che **builda il frontend**, aggiungi la variabile:
   ```
   VITE_PICOVOICE_ACCESS_KEY=la_tua_access_key
   ```
   ⚠️ Le env di Vite sono "cotte" al momento della build: dopo averla aggiunta fai un **redeploy**.

## 2. Keyword "Ehy HQ" (file .ppn)
1. Console Picovoice → **Porcupine** → *Train Wake Word*
2. Frase: `Ehy HQ` (o `Hey HQ` / `Ehi HQ`, prova quale riconosce meglio)
3. Lingua: scegli la stessa del file params al punto 3 (consiglio **English** per "HQ" letto a lettere)
4. Platform: **Web (WASM)**
5. Scarica il `.ppn` e rinominalo **`Ehy_HQ.ppn`**, mettilo in questa cartella

## 3. Modello lingua (file .pv)
Dalla pagina dei modelli Porcupine scarica il **params** della stessa lingua del keyword
(es. `porcupine_params.pv` per English) e mettilo qui rinominato **`porcupine_params.pv`**.

## Risultato atteso
```
frontend/public/picovoice/
  ├── Ehy_HQ.ppn
  └── porcupine_params.pv
```
A quel punto, su telefono con la scheda aperta, dire **"Ehy HQ"** apre la chat, registra la
frase, la trascrive con Whisper e la invia da sola.

> Nota onesta: una web app ascolta solo con la scheda **aperta e in primo piano** (niente
> background come Siri/Alexa) e richiede il permesso microfono.
