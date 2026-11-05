# Easy Control — Setup Guide

## 1. Crea il progetto Supabase

1. Vai su [supabase.com](https://supabase.com) → **New project**
2. Dai un nome (es. `easy-control`), scegli una password per il DB, seleziona la region Europa
3. Aspetta ~2 minuti che il progetto si inizializzi

## 2. Esegui lo schema SQL

1. Nel pannello Supabase → **SQL Editor** → **New query**
2. Incolla il contenuto di `sql/schema.sql`
3. Clicca **Run** — deve completare senza errori

## 3. Abilita Realtime

1. **Database → Replication** (o **Realtime** nel menu)
2. Abilita le seguenti tabelle:
   - `assignments`
   - `daily_reports`
   - `colleagues`
   - `state_filters`
   - `app_config`

## 4. Recupera le credenziali

1. **Settings → API**
2. Copia:
   - **Project URL** → es. `https://abcdefgh.supabase.co`
   - **anon / public key** → lunga stringa JWT

## 5. Configura l'app

Apri `js/config.js` e sostituisci i valori:

```js
const SUPABASE_URL = 'https://TUO_PROGETTO.supabase.co';
const SUPABASE_ANON_KEY  = 'TUA_ANON_KEY';
```

## 6. Crea il primo utente Admin

1. Supabase → **Authentication → Users → Invite user** (o Add user)
2. Inserisci la tua email e una password
3. Dopo che l'utente è stato creato, vai su **Table Editor → profiles**
4. Trova la riga con la tua email, clicca **Edit** e cambia `role` da `user` a `admin`

> Tutti gli altri utenti che si registreranno avranno ruolo `user` di default.

## 7. Deploy

### Vercel (consigliato)
```bash
npm i -g vercel
cd easy-control
vercel --prod
```
Oppure trascina la cartella `easy-control/` su [vercel.com/new](https://vercel.com/new) (Import → drag & drop).

### Netlify
```bash
npm i -g netlify-cli
cd easy-control
netlify deploy --prod --dir .
```
Oppure trascina la cartella su [app.netlify.com](https://app.netlify.com) → drag & drop.

## 8. Condividi il link

Una volta deployato, il link pubblico è qualcosa tipo:
- Vercel: `https://easy-control.vercel.app`
- Netlify: `https://easy-control.netlify.app`

Condividilo con i tuoi collaboratori. Ogni utente si registra la prima volta con email + password; il login persiste sul dispositivo.

---

## Struttura file

```
easy-control/
├── index.html          Login page
├── app.html            App principale (SPA)
├── js/
│   ├── config.js       ← MODIFICA QUESTO con le tue credenziali
│   ├── supabase-client.js
│   ├── auth.js
│   ├── db.js
│   ├── engine.js       Algoritmo distribuzione
│   ├── realtime.js     Subscriptions real-time
│   ├── ui.js
│   ├── admin.js
│   └── app.js
├── css/app.css
├── sql/schema.sql      Schema DB
├── vercel.json
└── netlify.toml
```
