# Build plan — sista dygnet

**Princip: försäljningen väntar inte på produkten.**

Traction är 18 poäng och kräver tre betalande. Produkten är noll poäng i sig. Därför byggs betalflödet och den manuella leveransvägen först av allt, och någon står i varuhuset långt innan appen är klar.

Fyll i era faktiska klockslag i vänsterkolumnen. Det viktiga är ordningen och grindarna, inte timmarna.

Version 2 · 2026-08-29 · kalibrerad mot vad som faktiskt finns i repot.

---

## Läs det här först: planen var skriven för fel utgångsläge

Version 1 antog att ingenting var byggt. Det stämmer inte, och skillnaden är stor nog att ändra ordningen på arbetet. Tre saker:

**Halva fas 2 är redan klar och verifierad.** Foto → matchning, manual → steg, steg → röst — alla tre kör i dag, hela vägen till en färdig 1080p-video med svensk berättarröst. Det finns en komplett guide i databasen: KALLAX, 16 steg, 5:01. Bygg inte om det.

**Fas 3:s sidospår är omöjligt.** Planen säger "en generativ hero-sekvens via ElevenLabs videomodeller". **ElevenLabs gör inte video. Bara ljud.** Den halvtimmen hade blivit trettio minuters felsökning av något som inte finns. Struket.

**Fas 3:s huvudspår är redan löst, men inte på det sätt planen tror.** Planen utpekar segmentering — att bryta ut enskilda delar ur illustrationen — som det svåra steget som hela den visuella vinkeln hänger på. Vi gör inte det. Vi renderar manualsidan som bild och panorerar och zoomar in på rätt region av sidan, synkat mot rösten. Det är enklare, det hittar aldrig på en pixel, och **det fungerar redan**. Risken planen oroar sig för är konstruerad bort, inte löst.

**Och en sak planen inte nämner alls, som är det som faktiskt blockerar demot:** gränssnittet är inte kopplat till backend. `src/App.tsx` innehåller noll anrop till `src/lib/api.ts`. Backend är klar, UI är klar, de pratar inte med varandra. Det är den enskilt viktigaste uppgiften i hela dokumentet och den saknades.

Nettoeffekten: mindre kvar att bygga än ni trodde, men det som är kvar ligger på en annan plats.

---

## Kritisk väg, i en mening

**Betalning → koppla ihop UI och backend → förbygg guider för det folk faktiskt bär ut → röststyrning → frys.**

Allt annat är trevligt. De fem sakerna är skillnaden mellan 18 poäng och 6.

---

## Fas 0 — Innan någon skriver kod (30 min)

| Vad | Vem | Klart när |
|---|---|---|
| Sätt upp betalflöde: Swish-nummer eller Stripe-länk + QR | kommersiell | **Någon kan betala 49 kr på en främmande mobil** |
| Bestäm de 50 manualerna efter försäljningsvolym — och plocka ut de 10–20 som ska förbyggas i kväll | kommersiell | Listan finns skriven, de 10–20 är markerade |
| Verifiera att appen går att nå från en främmande telefon | teknisk | En mobil utanför vårt nät öppnar appen och spelar en video |
| Starta bibliotekshämtningen mot de markerade artiklarna | teknisk | Kör i bakgrunden |
| ~~Skapa datamodellen med tillverkare som fält~~ | ~~teknisk~~ | **Klart.** 14 tabeller, `market`/tillverkare som fält, migrationer i `db/migrations/` |
| ~~Firecrawl-jobb startat mot manualarkiven~~ | ~~teknisk~~ | **Struket, se nedan** |

**Om Firecrawl:** det finns ingen API-nyckel på maskinen och den behövs inte som huvudväg. IKEA:s egen sök-endpoint svarar `200` härifrån, och en riktig monteringsanvisning hämtas som `200 application/pdf, 847 kB`. Vi hämtar direkt. Firecrawl är fallback när direktvägen inte räcker, och det är redan inkopplat som fallback i `manual.ts` — det tänds av sig självt den dag en nyckel finns. Lägg ingen tid här.

**Om räckbarheten, som är den nya raden:** databasen och API:t kör lokalt i den här sandboxen. Om den kommersiella halvan ska sälja i varuhuset måste kundens telefon kunna öppna något. Bestäm i fas 0 vilket: en publik tunnel till den här maskinen, eller att guiden levereras som en länk/fil i efterhand. Båda funkar. Att upptäcka klockan 16 att ingen utanför rummet kan öppna appen funkar inte.

> ### Grind 0
> **Ingen går vidare förrän man kan ta emot 49 kr från en okänd person.** Det är det enda som ger poäng.

---

## Fas 1 — Sälj innan ni har allt (parallellt, direkt)

Den kommersiella halvan åker till varuhuset nu.

**Skillnaden mot version 1: ni åker inte med bara en QR-kod.** Ni har en färdig guide att visa på er egen telefon. Att hålla upp en spelande video med svensk röst medan ni pratar är en helt annan försäljning än att beskriva en idé. Ta med KALLAX-guiden nedladdad och spelbar utan nät.

**Erbjudandet:** "Vi bygger en röstguide till möbeln du precis köpt. 49 kr, du får den inom en timme." Om produkten råkar vara en av de förbyggda — leverera på plats, direkt. Det är den bästa konverteringen ni kommer få.

**Om appen inte känner igen produkten** — ta betalt ändå, gör guiden och skicka länken. Det är inte fusk, det är hur en tjänst ser ut innan den automatiserats. En ny guide tar 4–6 minuter att producera, så "inom en timme" är ett löfte ni håller med marginal även om ni står kvar i butiken.

**Vad som ska med hem:**

- Betalande kunder — målet är tre, taket är högre
- Ordagranna citat, nedskrivna exakt som de sägs
- Vilka produkter folk faktiskt bar ut — det är nästa 50 manualer
- Konverteringen: tillfrågade kontra betalande
- Hur många av de tillfrågade som redan googlat eller sökt på YouTube under en montering — det är svaret på "men gratisalternativet finns ju"

---

## Fas 2 — Kärnflödet

Bygg i den här ordningen, testa efter varje steg. De tre första raderna är avklarade — de står kvar så att ni ser vad som redan finns och inte råkar bygga om det.

| # | Vad | Status |
|---|---|---|
| 1 | ~~Foto → matchning mot förladdade manualer~~ | **Klart.** Kandidatlista med konfidens, artikelnummer och namn, plus omval om matchningen är fel |
| 2 | ~~Manualen → steg~~ | **Klart.** 16 steg ur en 20-sidig PDF, med delar, verktyg och varningar per steg |
| 3 | ~~Steg → röst~~ | **Klart.** Svensk berättarröst per steg, cachad per textsträng |
| 4 | **Koppla UI till backend** | **Gör detta först.** Klienten finns skriven och typad i `src/lib/api.ts` — fem anrop, skriv ingen egen fetch-logik. Kontraktet ligger i `.context/API_CONTRACT.md` |
| 5 | **Röststyrning** — "nästa" och "backa". Inget mer | Ej byggt |
| 6 | **Betalning före första steget** | Ej byggt |
| 7 | **Missloggning** — produkt och tidpunkt vid varje träffmiss | Ej byggt |

**Om punkt 4, eftersom den är ny och kritisk:** de fem stegen i backendens progressström mappar exakt mot den befintliga stegtexten i gränssnittet (0 läser etiketten · 1 identifierar modell · 2 hittar anvisning · 3 planerar sekvens · 4 skapar video). Det finns en färdiggenererad guide att bygga resultatvyn mot utan att vänta på en körning. Sätt `API_ORIGIN` rätt — vite-proxyn pekar på port 3002 som standard, API:t kör på 3902.

> ### Grind 2a — efter punkt 4
> **Kan någon fota en möbel i rummet och få en spelande guide, utan att en utvecklare rör något?** Innan det är sant finns det inget demo, bara två halvor.

> ### Grind 2b — efter punkt 5
> **Kan en person i rummet montera något med bara rösten, utan att röra skärmen?** Fungerar det inte här spelar det visuella ingen roll.

---

## Fas 3 — Det visuella

**Huvudspåret är byggt.** Manualsidan renderas till bild, ffmpeg beskär och panorerar mot rätt region av sidan — topp, mitt, botten eller hel sida — med rubrik, bildtext och varningstext över, synkat mot rösten steg för steg. Det hittar aldrig på en pixel, eftersom varje bildruta kommer ur tillverkarens egen PDF.

**Det som återstår här är finjustering, inte konstruktion:**

- Träffar zoom-regionen rätt del av sidan för de förbyggda guiderna? Titta igenom dem. Det är en ögonuppgift, inte en kodfråga.
- Är texten läsbar på en telefon i ett upplyst varuhus?

**Struket ur version 1:**

- ~~Segmentering av delar ur illustrationen~~ — vi gör sidregion i stället för del. Enklare, redan byggt, samma pedagogiska effekt.
- ~~Generativ hero-sekvens via ElevenLabs videomodeller~~ — **finns inte.** ElevenLabs gör ljud, inte video.
- ~~Creditkoll för video per sekund~~ — bygger på samma missförstånd. **Den kvot som faktiskt tar slut är ElevenLabs teckenkvot för tal.** Läs av den innan ni förbygger tjugo guider. Återanvänd röst kostar noll — bara nya guider drar.

**Budget för förbyggnaden, mätt och inte uppskattad:** en ny guide kostar **$1,17** i modellanrop. Tjugo förbyggda guider ≈ $23. Det finns en hård spärr på `$3.00` per körning i koden. Det här är inte ett problem, men någon ska ha sett siffran innan den dyker upp på en faktura.

---

## Fas 4 — Demofrys

Sätt en tidpunkt och håll den. **Minst två timmar före pitch.** Efter frysen: inga nya funktioner. Bara körningar av demot, om och om igen.

**Checklista:**

- [ ] Demot körs utan ett enda nödvändigt nätverksanrop
- [ ] `MOCK_ORCHESTRATOR=1` testad och fungerar — den går samma väg med riktig databas, riktig röst och riktig rendering, bara resonemanget är skriptat. Ingen i publiken kan se skillnaden
- [ ] Den färdiga KALLAX-guiden ligger nedladdad och spelar utan nät (videon är 39 MB — ladda ner den, streama den inte)
- [ ] Fallbacken failar inom femton sekunder med ett vettigt meddelande
- [ ] Kandidatlistan testad: fota fel sak med flit och välj rätt produkt manuellt
- [ ] Telefonen är laddad, flygplansläge testat, skärmsläckaren avstängd
- [ ] Någon annan än den som byggt har kört demot hela vägen igenom
- [ ] Siffrorna från varuhuset är inklistrade i specen — inga `[FYLL I]` kvar
- [ ] `[KÄLLA]`-påståendena i affärsspecen är kontrollerade eller strukna

---

## Fas 5 — Pitchen (sista timmen)

Kör den högt tre gånger. Inte i huvudet.

1. **Citatet från varuhuset** — en människa, inte en siffra
2. **Live-demo, under 90 sekunder** — och avsluta det med en **följdfråga ställd högt och besvarad**. Att fråga "vilka skruvar i steg 4?" och få svar ur den faktiska manualen är det som skiljer produkten från en video. Det är byggt, det svarar på ~15 sekunder, och det är det starkaste i hela demot. Missa det inte.
3. **Traction:** betalande, intäkt, konvertering
4. **Modellen**, och varför inte abonnemang — med den uppmätta kostnaden per guide, inte en gissning
5. **Wedgen:** montering nu, hemmet sen, i den ordningen och varför
6. **Konkurrenterna**, nämnda av er
7. **Vad ni gör på måndag**

**Ha svaren klara på:**

- Vad händer när IKEA bygger det själva?
- Varför inte YouTube?
- Vad har ni valt bort och varför?
- **Hur många manualer har ni på riktigt?** — Svara med den sanna siffran och hur ni verifierar den. Vi hade tvåhundra i morse och kunde inte bevisa en enda; nu har vi färre och kan bevisa varenda en. Det svaret är starkare än en stor siffra, och det är dessutom sant.

---

## Stopregler

- **Inga nya idéer efter fas 0.** Scopet är låst. Bredden är något ni säger, inte något ni bygger.
- **Fastnar ett tekniskt moment i mer än 45 minuter — klipp det och gå vidare.** Ett fungerande smalt demo slår ett brett som hänger sig.
- **Faller det visuella** — kör röst med statiska manualbilder. Produkten fungerar ändå.
- **Faller igenkänningen** — låt användaren välja möbel ur en lista. Fult, men demot lever. *Den fallbacken finns redan byggd — kandidatlistan och omvalet.*
- **Faller Claude eller nätet** — kör `MOCK_ORCHESTRATOR=1`. Samma väg, samma händelser, riktig video ut.
- **Faller allt** — spela den förinspelade skärmvideon av hela flödet. Gör den före frysen, inte efter.

**Det enda som inte får falla är betalflödet och siffrorna från varuhuset.**

---

## Vad som är sant just nu, för den som inte läst affärsspecen

| | |
|---|---|
| Hela kedjan foto → manual → steg → röst → video | **Byggd och verifierad** |
| Följdfrågor mot den faktiska manualen | **Byggd**, ~15 s |
| Omval vid felmatchning | **Byggd** |
| Demoläge utan modellberoende | **Byggd** |
| UI kopplat till backend | **Nej** — kritisk väg |
| Biblioteket | **1 produkt, äkta hela vägen.** KALLAX `202.758.14`, officiell 20-sidig svensk anvisning, PDF nedladdad, SHA-256 stämmer |
| Röststyrning, betalning, missloggning | **Nej** |
| Publikt nåbar tjänst | **Nej** |
| Kostnad per ny guide | **$1,17**, uppmätt |
| Tid för ny guide | **4–6 min.** Guide som redan finns: startar direkt |

Detaljerna, inklusive hur den fabricerade katalogen upptäcktes och rensades, står i `BUSINESS-SPEC.md` sektion 0.
