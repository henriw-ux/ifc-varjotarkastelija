# IFC-varjotarkastelija

Selainsovellus, jolla rakennushankkeen IFC-tietomalli sijoitetaan osoitteen perusteella
[ShadeMapin](https://shademap.app/) karttanäkymään ja jonka 3D-näkymässä voi mennä mallin
sisälle tarkastelemaan, miten aurinko ja ympäröivien rakennusten varjot osuvat tiloihin.

## Käynnistys

```bash
npm install
npm run dev        # kehityspalvelin, http://localhost:5173
npm run build      # staattinen tuotantoversio hakemistoon dist/
```

Tarvitset ShadeMap-API-avaimen: <https://shademap.app/about/>. Avainta ei ole sovelluksen
koodissa: jokainen käyttäjä syöttää omansa sovelluksen yläreunan *ShadeMap API-avain* -kenttään,
ja se tallentuu vain hänen selaimensa localStorageen.

## Julkaisu (GitHub Pages)

`.github/workflows/pages.yml` rakentaa ja julkaisee sovelluksen jokaisesta `main`-haaran pushista.
Ota käyttöön: repositorion *Settings → Pages → Build and deployment → Source: GitHub Actions*. Ilman avainta 3D-näkymä ja tila-analyysit
toimivat, mutta kartalla ei näy varjoja.

Testimalli: `public/esimerkki.ifc` (myös painike *Käytä esimerkkimallia*) (2-kerroksinen L-talo, ikkunat, 6 tilaa). Uuden voi tehdä
komennolla `python3 tools/make_test_ifc.py oma.ifc [--georef]` (vaatii `pip install ifcopenshell`).

## Käyttö

1. **Lähtötiedot** – API-avain, `.ifc`-tiedosto ja rakennuspaikan osoite → *Lataa ja sijoita malli*.
2. **Sijoitus** – osoite geokoodataan (OpenStreetMap Nominatim) ja mallin jalanjälkeä verrataan
   ShadeMapin rakennusaineiston rakennusmuotoihin osoitteen kohdalla: sovitus hakee kierron ja
   siirron, joilla mallin ja kartan rakennuksen muodot vastaavat parhaiten toisiaan (IoU näytetään,
   verratut rakennukset sinisellä katkoviivalla). Sijoitusta voi hienosäätää kentillä tai vetämällä
   mallia kartalla (Shift + veto kiertää). Jos IFC:ssä on georeferointi (IfcMapConversion
   ETRS-TM35FIN/ETRS-GK -koordinaatistossa tai IfcSite RefLatitude/RefLongitude + TrueNorth),
   sitä voidaan käyttää suoraan.
3. **Ajankohta** – päivä ja kellonaika ovat yhteiset kartalle ja 3D-näkymälle. Kartalla voi
   näyttää myös ShadeMapin koko päivän aurinkotunnit.
4. **Tilat ja kerrokset** – IfcSpace-tilat kerroksittain. Tilan klikkaus vie kävelytilaan tilan
   sisälle; kerroksen otsikko näyttää kerrosleikkauksen ylhäältä. *Analysoi* laskee säteenseurannalla
   suoran auringonpaisteen tunnit lattia- tai työtasolle valittuna päivänä (lasi päästää valon läpi,
   ympäröivät rakennukset ja mallin omat osat varjostavat) ja näyttää tuloksen lämpökarttana.
5. **3D-näkymä** – kiertotila / kävelytila (WASD + hiiri), tuplaklikkaus lattiaan siirtää sinne.

## Toteutus

| Osa | Tiedosto | Kirjastot |
| --- | --- | --- |
| IFC-luku, tilat, kerrokset, georeferointi, jalanjälki | `src/ifc.js` | web-ifc, three.js |
| Kartta + ShadeMap-varjot, mallin rakennukset ShadeMapille | `src/map.js` | maplibre-gl, mapbox-gl-shadow-simulator |
| Muotosovitus kartan rakennuksiin | `src/fit.js` | – |
| 3D, aurinko, varjot, kävely, auringonpaisteanalyysi | `src/viewer3d.js` | three.js, three-mesh-bvh, suncalc |
| Projektiot (TM35FIN, GK19–31), geokoodaus | `src/geo.js` | proj4 |

Mallin jalanjälki lasketaan korkeusrasterina (0,5 m), joka yhdistetään suorakaiteiksi ja annetaan
ShadeMapille lisärakennuksina – kartalla näkyvät siis myös uuden rakennuksen varjot. Kartan
rakennukset mallin alueella poistetaan (valinta "Korvaa kartan rakennukset"). Samat ShadeMapin
rakennukset puretaan 3D-näkymään ympäristöksi.

## Rajoitukset

- Ajat tulkitaan selaimen aikavyöhykkeessä.
- ShadeMap ei tue rakennusten alakorkeutta: ulokkeet varjostavat kartalla maahan asti (3D-näkymässä oikein).
- 3D-näkymän maasto on tasainen; kartan varjoissa maasto on mukana.
- Ympäröivien rakennusten korkeudet tulevat ShadeMapin/OSM:n aineistosta, ja niiden tarkkuus vaihtelee.
- Lasiksi tulkitaan läpinäkyvät pinnat sekä IfcWindow-/IfcPlate-elementit, joissa ei ole läpinäkyvää osaa.
- ShadeMap-kirjasto on kaupallinen (UNLICENSED, käyttö API-avaimella ShadeMapin ehdoin).
