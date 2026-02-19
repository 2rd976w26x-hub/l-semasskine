# Læsemaskine (MVP) – læsetræning med progression, AI-vurdering og gruppe-dashboards

**Version:** 0.2.1.2.2  
**Dato:** 2026-02-14

Læsemaskine er en isoleret mini-app i dette repo. Den er bygget, så den kan ligge side om side med Piratwhist **uden at påvirke Piratwhist**.

- Ingen ændringer i Piratwhist-filer
- Ingen link fra Piratwhist-startsiden endnu
- Alt ligger under `/laesemaskine/`
- API ligger under `/laesemaskine/api/*`
- DB-tabeller har prefix `lm_`

---

## Funktioner i denne version (MVP)
### Elev
- Login + opret bruger
- 20 ord pr session (ét ord ad gangen)
- Feedback-toggle:
  - efter hvert ord
  - efter testen
- Talegenkendelse (browser SpeechRecognition)
- Adaptiv niveautest (niveau justeres undervejs)
- Resultat-side (rigtige + estimeret niveau + stjerner)
- Progression: mestring 1–10 pr niveau (gemmes i DB)

### Gruppe-admin
- Opret grupper
- Opret elevkonti og placér i gruppe
- Oversigt over elever: gruppe, seneste niveau, seneste mestring

### Data
- Excel → JSON parser (words.json)
- Ord vælges efter niveau (+/- band for variation)

---

## Repo-struktur
```
laesemaskine/
  frontend/                # HTML/CSS/JS
  data/words.json          # genereret fra Excel
  backend/
    app.py                 # Flask server + API
    requirements.txt
    excel_to_json.py       # Excel → JSON værktøj
    db/
      schema.sql           # SQLite schema (lm_*)
```

---

## Kom godt i gang (lokalt)
### 1) Installer backend dependencies
```bash
cd laesemaskine/backend
python -m venv .venv
source .venv/bin/activate  # (Windows: .venv\Scripts\activate)
pip install -r requirements.txt
```

### 2) Opret DB (sker automatisk ved første start)
```bash
python app.py
```

Server starter på:
- http://localhost:5000/laesemaskine/

### 3) Log ind
- Opret en bruger på login-siden
- Vælg rolle:
  - Elev
  - Admin (gruppe-admin)

---

## Excel → JSON (ordliste)
Hvis ordlisten ændres:
```bash
cd laesemaskine/backend
python excel_to_json.py --excel /path/to/Ordtraening.xlsx --out ../data/words.json
```

---

## API (kort)
- `POST /laesemaskine/api/auth/register`
- `POST /laesemaskine/api/auth/login`
- `POST /laesemaskine/api/auth/logout`
- `GET  /laesemaskine/api/me`
- `GET  /laesemaskine/api/words?level=3&count=20&band=1`
- `POST /laesemaskine/api/sessions/start`
- `POST /laesemaskine/api/sessions/<id>/answer`
- `POST /laesemaskine/api/sessions/<id>/finish`
- Admin:
  - `GET/POST /laesemaskine/api/admin/groups`
  - `POST      /laesemaskine/api/admin/users`
  - `GET       /laesemaskine/api/admin/overview`

---

## Adaptiv algoritme (MVP)
- Rolling window på 5 svar:
  - 4/5 rigtige → niveau op
  - 3/5 forkerte → niveau ned
- Clamp 1–30

---

## GDPR (kladde)
Se: `PRIVACY.md` og den læsevenlige version i browser: `/laesemaskine/PRIVACY.html`

Principper i MVP:
- Ingen rå lyd gemmes
- Ingen CPR/adresse/fødselsdato
- Kun nødvendige læringsdata gemmes

---

## Pædagogik (avanceret forslag)
Se: `PEDAGOGY.md`

---

## MVP TODO (næste forbedringer)
- Tolerance i vurdering (Levenshtein / “næsten korrekt”)
- Mønsteranalyse pr elev (stumt d, ng/nk, klynger osv.)
- Trendberegning i admin-oversigt
- Bedre session-mix (12/4/4 omkring niveau)
- “Frustrations-guard” (skift til lettere ord ved mange fejl i træk)
