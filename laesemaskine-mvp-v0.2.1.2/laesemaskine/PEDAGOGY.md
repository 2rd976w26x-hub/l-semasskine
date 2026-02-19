# Pædagogisk model for progression (avanceret – forslag)

**Version:** 0.2.1.2.2  
**Dato:** 2026-02-14

Dette dokument foreslår en mere avanceret model end MVP, men kan implementeres gradvist.

## 1) Tre-lags progression
1. **Placering** (hvilket niveau passer eleven til lige nu?)
2. **Mestring pr niveau** (1–10: hvor sikker er eleven på netop dette niveau?)
3. **Mønsterprofil** (hvad driller: stumt d, ng/nk, klynger, endelser osv.)

## 2) Session-sammensætning (20 ord)
Et godt standardmix:
- 12 ord: aktuelt niveau (flow)
- 4 ord: niveau -1 (selvtillid / automatisering)
- 4 ord: niveau +1 (progression)

Hvis elev er presset:
- 14/4/2 (mere let)
Hvis elev er stærk:
- 10/4/6 (mere svært)

## 3) Mestring (1–10) som glidende score
I stedet for at erstatte mestring hver gang:
- Brug glidende gennemsnit eller “ELO-lignende” opdatering.

Eksempel:
- mastery_new = round( 0.8 * mastery_old + 0.2 * mastery_session )

Hvor mastery_session = round((korrekt/20)*10)

## 4) Stopregler og “frustrations-guard”
For at undgå at eleven mister modet:
- Hvis eleven har 4 fejl i træk → skift til lettere ord resten af sessionen
- Hvis elev bruger meget lang tid pr ord → tilbyd “vis igen” som hjælp (tæller som hjælp)

## 5) Feedback-mode (valg)
- **Pr ord:** godt ved tidlig træning og tydelig læring
- **Efter session:** mindre pres, bedre for ængstelige elever

Anbefaling:
- Lad appen foreslå mode ud fra elevens fejlrate (men eleven kan altid vælge selv)

## 6) Mønstertræning (målrettet støtte)
Brug Excel-felterne:
- Stavemønster, Morfologi, Ordblind-type

Log:
- fejl pr mønster
- succes pr mønster

Så kan dashboard vise:
- “Du er blevet bedre til dobbeltkonsonant”
- “Stumt d driller stadig”

## 7) Motivation og belønninger
Hold belønninger “lav-støj”:
- synlig progression
- små badges
- streak (valgfrit) – men undgå straf ved at miste streak

## 8) Anbefalet progressionstempo
- Små mål: 2–5 sessioner pr uge
- Tydelig fejring af mikrosejre

