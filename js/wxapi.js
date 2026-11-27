/*
 * wxapi.js - FREE data layer for Population Weatherscan
 * ------------------------------------------------------------------
 * Replaces the paid weather.com (TWC) API and the paid ip-api "pro"
 * endpoint with free, keyless services, WITHOUT changing the rest of the
 * app. It works by wrapping $.getJSON: any request to api.weather.com or
 * pro.ip-api.com is answered here, in the exact JSON shape the old API
 * returned, so data.js / location.js / slides.js keep working as-is.
 *
 *   Weather / forecast / UV ..... Open-Meteo      (open-meteo.com, no key)
 *   Alerts (US) ................. NWS             (api.weather.gov, no key)
 *   Place search / ZIP lookup ... Open-Meteo geocoding (no key)
 *   Reverse geocode (lat,lon) ... BigDataCloud client API (no key)
 *   "Nearby" towns .............. OpenStreetMap Overpass (+ built-in fallback list)
 *   Airports .................... built-in table below (add more if needed)
 *   IP geolocation .............. ipwho.is, then geojs.io (no key)
 *
 * Open-Meteo's free tier is for NON-COMMERCIAL use. For commercial use
 * you need their paid plan (or self-host) - see open-meteo.com/en/pricing
 */
(function (window, $) {
  "use strict";

  var OM_FORECAST = "https://api.open-meteo.com/v1/forecast";
  var OM_GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";
  var BDC_REVERSE = "https://api.bigdatacloud.net/data/reverse-geocode-client";
  var NWS = "https://api.weather.gov";
  var OVERPASS = "https://overpass-api.de/api/interpreter";

  /* ------------------------------------------------------------------ */
  /* small utilities                                                     */
  /* ------------------------------------------------------------------ */
  function fetchJSON(url, timeoutMs, headers) {
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 10000) : null;
    var opts = { headers: headers || {} };
    if (ctl) opts.signal = ctl.signal;
    return fetch(url, opts).then(function (r) {
      if (timer) clearTimeout(timer);
      if (!r.ok) { var e = new Error("HTTP " + r.status + " for " + url); e.status = r.status; throw e; }
      return r.json();
    }, function (err) { if (timer) clearTimeout(timer); throw err; });
  }

  var cache = {};
  function cached(key, ttlMs, fn) {
    var e = cache[key];
    if (e && Date.now() - e.t < ttlMs) return e.p;
    var p = fn();
    cache[key] = { t: Date.now(), p: p };
    p.catch(function () { if (cache[key] && cache[key].p === p) delete cache[key]; });
    return p;
  }

  function num(v) { return typeof v === "number" ? v : parseFloat(v); }
  function round(v) { return v == null || isNaN(v) ? null : Math.round(v); }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function haversineKm(la1, lo1, la2, lo2) {
    var R = 6371, rad = Math.PI / 180;
    var dLa = (la2 - la1) * rad, dLo = (lo2 - lo1) * rad;
    var a = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
      Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function parseGeocode(s) {
    var p = String(s || "").split(",");
    return { lat: num(p[0]), lon: num(p[1]) };
  }
  function isEs(lang) { return /^es/i.test(lang || ""); }
  function placeKey(lat, lon) { return num(lat).toFixed(4) + "," + num(lon).toFixed(4); }
  function offsetStr(sec) {
    var s = sec < 0 ? "-" : "+"; sec = Math.abs(sec);
    return s + pad2(Math.floor(sec / 3600)) + ":" + pad2(Math.floor((sec % 3600) / 60));
  }

  /* ------------------------------------------------------------------ */
  /* static tables                                                       */
  /* ------------------------------------------------------------------ */
  var US_STATES = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA", "Colorado": "CO",
    "Connecticut": "CT", "Delaware": "DE", "District of Columbia": "DC", "Florida": "FL", "Georgia": "GA",
    "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS",
    "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD", "Massachusetts": "MA",
    "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS", "Missouri": "MO", "Montana": "MT",
    "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM",
    "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK",
    "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD",
    "Tennessee": "TN", "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA", "Washington": "WA",
    "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY", "Puerto Rico": "PR"
  };
  var STATE_BY_CODE = {};
  Object.keys(US_STATES).forEach(function (k) { STATE_BY_CODE[US_STATES[k]] = k; });

  // IATA|Airport name|lat|lon|state     (extend freely - this is the only place airports come from)
  var AIRPORTS = [
    "ATL|Atlanta Hartsfield-Jackson|33.6407|-84.4277|GA", "LAX|Los Angeles Intl|33.9425|-118.4081|CA",
    "ORD|Chicago O'Hare|41.9742|-87.9073|IL", "DFW|Dallas/Fort Worth|32.8998|-97.0403|TX",
    "DEN|Denver Intl|39.8561|-104.6737|CO", "JFK|New York JFK|40.6413|-73.7781|NY",
    "SFO|San Francisco Intl|37.6213|-122.3790|CA", "SEA|Seattle-Tacoma|47.4502|-122.3088|WA",
    "LAS|Las Vegas Harry Reid|36.0840|-115.1537|NV", "MCO|Orlando Intl|28.4312|-81.3081|FL",
    "EWR|Newark Liberty|40.6895|-74.1745|NJ", "CLT|Charlotte Douglas|35.2140|-80.9431|NC",
    "PHX|Phoenix Sky Harbor|33.4343|-112.0116|AZ", "IAH|Houston Bush Intercontinental|29.9902|-95.3368|TX",
    "MIA|Miami Intl|25.7959|-80.2870|FL", "BOS|Boston Logan|42.3656|-71.0096|MA",
    "MSP|Minneapolis-St. Paul|44.8848|-93.2223|MN", "FLL|Fort Lauderdale-Hollywood|26.0742|-80.1506|FL",
    "DTW|Detroit Metro|42.2162|-83.3554|MI", "PHL|Philadelphia Intl|39.8744|-75.2424|PA",
    "LGA|New York LaGuardia|40.7769|-73.8740|NY", "BWI|Baltimore/Washington|39.1774|-76.6684|MD",
    "SLC|Salt Lake City Intl|40.7899|-111.9791|UT", "SAN|San Diego Intl|32.7338|-117.1933|CA",
    "DCA|Washington Reagan|38.8512|-77.0402|VA", "IAD|Washington Dulles|38.9531|-77.4565|VA",
    "TPA|Tampa Intl|27.9755|-82.5332|FL", "PDX|Portland Intl|45.5898|-122.5951|OR",
    "STL|St. Louis Lambert|38.7487|-90.3700|MO", "HNL|Honolulu Intl|21.3187|-157.9225|HI",
    "BNA|Nashville Intl|36.1263|-86.6774|TN", "AUS|Austin-Bergstrom|30.1945|-97.6699|TX",
    "MDW|Chicago Midway|41.7868|-87.7522|IL", "DAL|Dallas Love Field|32.8471|-96.8518|TX",
    "OAK|Oakland Intl|37.7213|-122.2208|CA", "MSY|New Orleans Armstrong|29.9934|-90.2580|LA",
    "RDU|Raleigh-Durham|35.8776|-78.7875|NC", "SJC|San Jose Mineta|37.3639|-121.9289|CA",
    "SMF|Sacramento Intl|38.6954|-121.5908|CA", "SNA|Orange County John Wayne|33.6757|-117.8682|CA",
    "HOU|Houston Hobby|29.6454|-95.2789|TX", "MCI|Kansas City Intl|39.2976|-94.7139|MO",
    "SAT|San Antonio Intl|29.5337|-98.4698|TX", "CLE|Cleveland Hopkins|41.4117|-81.8498|OH",
    "CMH|Columbus John Glenn|39.9980|-82.8919|OH", "IND|Indianapolis Intl|39.7173|-86.2944|IN",
    "PIT|Pittsburgh Intl|40.4915|-80.2329|PA", "CVG|Cincinnati/N. Kentucky|39.0488|-84.6678|KY",
    "MKE|Milwaukee Mitchell|42.9472|-87.8966|WI", "SJU|San Juan Luis Munoz Marin|18.4394|-66.0018|PR",
    "JAX|Jacksonville Intl|30.4941|-81.6879|FL", "RSW|Southwest Florida Intl|26.5362|-81.7552|FL",
    "BDL|Hartford Bradley|41.9389|-72.6832|CT", "PVD|Providence T.F. Green|41.7240|-71.4282|RI",
    "BUF|Buffalo Niagara|42.9405|-78.7322|NY", "ROC|Rochester Intl|43.1189|-77.6724|NY",
    "ALB|Albany Intl|42.7483|-73.8017|NY", "SYR|Syracuse Hancock|43.1112|-76.1063|NY",
    "ORF|Norfolk Intl|36.8946|-76.2012|VA", "RIC|Richmond Intl|37.5052|-77.3197|VA",
    "CHS|Charleston Intl|32.8986|-80.0405|SC", "GSO|Greensboro Piedmont Triad|36.0978|-79.9373|NC",
    "MEM|Memphis Intl|35.0424|-89.9767|TN", "BHM|Birmingham-Shuttlesworth|33.5629|-86.7535|AL",
    "SDF|Louisville Muhammad Ali|38.1744|-85.7360|KY", "OKC|Oklahoma City Will Rogers|35.3931|-97.6007|OK",
    "TUL|Tulsa Intl|36.1984|-95.8881|OK", "OMA|Omaha Eppley|41.3032|-95.8941|NE",
    "DSM|Des Moines Intl|41.5340|-93.6631|IA", "ABQ|Albuquerque Sunport|35.0402|-106.6092|NM",
    "ELP|El Paso Intl|31.8072|-106.3776|TX", "TUS|Tucson Intl|32.1161|-110.9410|AZ",
    "BOI|Boise|43.5644|-116.2228|ID", "ANC|Anchorage Stevens|61.1744|-149.9964|AK",
    "PBI|Palm Beach Intl|26.6832|-80.0956|FL", "ACY|Atlantic City Intl|39.4576|-74.5772|NJ",
    "ABE|Lehigh Valley Intl|40.6521|-75.4408|PA", "TTN|Trenton-Mercer|40.2767|-74.8135|NJ",
    "PNE|Northeast Philadelphia|40.0819|-75.0107|PA", "ILG|Wilmington New Castle|39.6787|-75.6065|DE",
    "HGR|Hagerstown Regional|39.7079|-77.7295|MD", "MRB|Eastern WV Regional|39.4019|-77.9847|WV",
    "CBE|Greater Cumberland Regional|39.6154|-78.7609|MD", "CRW|Charleston Yeager|38.3731|-81.5932|WV",
    "CKB|Clarksburg North Central WV|39.2966|-80.2281|WV", "MGW|Morgantown Municipal|39.6429|-79.9163|WV",
    "HTS|Huntington Tri-State|38.3667|-82.5580|WV", "FDK|Frederick Municipal|39.4176|-77.3743|MD",
    "CHO|Charlottesville-Albemarle|38.1386|-78.4529|VA", "ROA|Roanoke-Blacksburg|37.3255|-79.9754|VA",
    "LYH|Lynchburg Regional|37.3267|-79.2004|VA", "MDT|Harrisburg Intl|40.1935|-76.7634|PA",
    "AVP|Wilkes-Barre/Scranton|41.3385|-75.7234|PA", "LBE|Arnold Palmer Regional|40.2759|-79.4048|PA",
    "LEX|Lexington Blue Grass|38.0365|-84.6059|KY", "TYS|Knoxville McGhee Tyson|35.8111|-83.9940|TN",
    "GRR|Grand Rapids Ford|42.8808|-85.5228|MI", "ICT|Wichita Eisenhower|37.6499|-97.4331|KS",
    "LIT|Little Rock Clinton|34.7294|-92.2243|AR", "MSN|Madison Dane County|43.1399|-89.3375|WI",
    "SAV|Savannah/Hilton Head|32.1276|-81.2021|GA", "PWM|Portland Intl Jetport|43.6462|-70.3093|ME",
    "BTV|Burlington Intl|44.4720|-73.1533|VT", "MHT|Manchester-Boston Regional|42.9326|-71.4357|NH",
    "RNO|Reno-Tahoe Intl|39.4991|-119.7681|NV", "COS|Colorado Springs|38.8058|-104.7009|CO",
    "FAT|Fresno Yosemite|36.7762|-119.7181|CA", "ONT|Ontario Intl|34.0560|-117.6012|CA",
    "BUR|Burbank Hollywood|34.2007|-118.3590|CA", "LGB|Long Beach|33.8177|-118.1516|CA"
  ].map(function (s) {
    var p = s.split("|");
    return { iata: p[0], name: p[1], lat: +p[2], lon: +p[3], state: p[4] };
  });

  // Fallback "nearby city" list, used only if the OpenStreetMap lookup is unreachable.
  // Name|ST|lat|lon
  var CITIES = [
    "New York|NY|40.71|-74.01", "Los Angeles|CA|34.05|-118.24", "Chicago|IL|41.88|-87.63", "Houston|TX|29.76|-95.37",
    "Phoenix|AZ|33.45|-112.07", "Philadelphia|PA|39.95|-75.17", "San Antonio|TX|29.42|-98.49", "San Diego|CA|32.72|-117.16",
    "Dallas|TX|32.78|-96.80", "Jacksonville|FL|30.33|-81.66", "Austin|TX|30.27|-97.74", "Columbus|OH|39.96|-83.00",
    "Charlotte|NC|35.23|-80.84", "San Francisco|CA|37.77|-122.42", "Indianapolis|IN|39.77|-86.16", "Seattle|WA|47.61|-122.33",
    "Denver|CO|39.74|-104.99", "Washington|DC|38.91|-77.04", "Boston|MA|42.36|-71.06", "Nashville|TN|36.16|-86.78",
    "Detroit|MI|42.33|-83.05", "Memphis|TN|35.15|-90.05", "Portland|OR|45.52|-122.68", "Las Vegas|NV|36.17|-115.14",
    "Louisville|KY|38.25|-85.76", "Baltimore|MD|39.29|-76.61", "Milwaukee|WI|43.04|-87.91", "Albuquerque|NM|35.08|-106.65",
    "Tucson|AZ|32.22|-110.97", "Sacramento|CA|38.58|-121.49", "Kansas City|MO|39.10|-94.58", "Atlanta|GA|33.75|-84.39",
    "Omaha|NE|41.26|-95.93", "Raleigh|NC|35.78|-78.64", "Miami|FL|25.76|-80.19", "Cleveland|OH|41.50|-81.69",
    "Tulsa|OK|36.15|-95.99", "Minneapolis|MN|44.98|-93.27", "New Orleans|LA|29.95|-90.07", "Tampa|FL|27.95|-82.46",
    "Pittsburgh|PA|40.44|-79.99", "Cincinnati|OH|39.10|-84.51", "St. Louis|MO|38.63|-90.20", "Orlando|FL|28.54|-81.38",
    "Buffalo|NY|42.89|-78.88", "Richmond|VA|37.54|-77.44", "Hartford|CT|41.76|-72.69", "Providence|RI|41.82|-71.41",
    "Salt Lake City|UT|40.76|-111.89", "Birmingham|AL|33.52|-86.80", "Charleston|WV|38.35|-81.63", "Hagerstown|MD|39.64|-77.72",
    "Cumberland|MD|39.65|-78.76", "Winchester|VA|39.19|-78.16", "Martinsburg|WV|39.46|-77.96", "Frederick|MD|39.41|-77.41",
    "Morgantown|WV|39.63|-79.96", "Harrisburg|PA|40.27|-76.88", "Allentown|PA|40.60|-75.47", "Newark|NJ|40.74|-74.17",
    "Wilmington|DE|39.74|-75.55", "Norfolk|VA|36.85|-76.29", "Albany|NY|42.65|-73.76", "Syracuse|NY|43.05|-76.15",
    "Rochester|NY|43.16|-77.61", "Lexington|KY|38.04|-84.50", "Knoxville|TN|35.96|-83.92", "Honolulu|HI|21.31|-157.86",
    "Anchorage|AK|61.22|-149.90", "Boise|ID|43.62|-116.20", "Oklahoma City|OK|35.47|-97.52", "Des Moines|IA|41.59|-93.62",
    "Little Rock|AR|34.75|-92.29", "Madison|WI|43.07|-89.40", "Baton Rouge|LA|30.45|-91.19", "Greensboro|NC|36.07|-79.79",
    "Savannah|GA|32.08|-81.09", "Charleston|SC|32.78|-79.93", "Jackson|MS|32.30|-90.18", "Columbia|SC|34.00|-81.03",
    "Lancaster|PA|40.04|-76.31", "Reading|PA|40.34|-75.93", "Scranton|PA|41.41|-75.66", "Trenton|NJ|40.22|-74.76",
    "Atlantic City|NJ|39.36|-74.42", "Dover|DE|39.16|-75.52", "Annapolis|MD|38.98|-76.49", "Roanoke|VA|37.27|-79.94",
    "Lynchburg|VA|37.41|-79.14", "Charlottesville|VA|38.03|-78.48", "Huntington|WV|38.42|-82.45", "Wheeling|WV|40.06|-80.72",
    "Parkersburg|WV|39.27|-81.56", "Clarksburg|WV|39.28|-80.34", "Elkins|WV|38.93|-79.85", "Fairmont|WV|39.48|-80.14"
  ].map(function (s) {
    var p = s.split("|");
    return { name: p[0], state: p[1], lat: +p[2], lon: +p[3] };
  });

  /* ------------------------------------------------------------------ */
  /* weather condition -> TWC icon code (0-47) + TWC-style phrase        */
  /* The app's images/icons/N.png are the TWC icon set, so this keeps    */
  /* every icon the app already ships working.                           */
  /* ------------------------------------------------------------------ */
  function skyFromCover(cover, isDay) {
    if (cover < 12) return isDay ? { i: 32, en: "Sunny", es: "Soleado" } : { i: 31, en: "Clear", es: "Despejado" };
    if (cover < 32) return isDay ? { i: 34, en: "Mostly Sunny", es: "Mayormente soleado" } : { i: 33, en: "Mostly Clear", es: "Mayormente despejado" };
    if (cover < 62) return isDay ? { i: 30, en: "Partly Cloudy", es: "Parcialmente nublado" } : { i: 29, en: "Partly Cloudy", es: "Parcialmente nublado" };
    if (cover < 87) return isDay ? { i: 28, en: "Mostly Cloudy", es: "Mayormente nublado" } : { i: 27, en: "Mostly Cloudy", es: "Mayormente nublado" };
    return { i: 26, en: "Cloudy", es: "Nublado" };
  }

  // kind: rain | snow | freezing | mix | thunder ; o = options
  function precipCond(kind, o, isDay) {
    o = o || {};
    switch (kind) {
      case "thunder":
        if (o.hail) return { i: 3, en: "Strong Thunderstorms", es: "Tormentas fuertes" };
        if (o.isolated) return { i: isDay ? 37 : 47, en: "Isolated Thunderstorms", es: "Tormentas aisladas" };
        if (o.scattered) return { i: isDay ? 38 : 47, en: "Scattered Thunderstorms", es: "Tormentas dispersas" };
        return { i: 4, en: "Thunderstorms", es: "Tormentas" };
      case "freezing":
        if (o.drizzle) return { i: 8, en: "Freezing Drizzle", es: "Llovizna helada" };
        return { i: 10, en: "Freezing Rain", es: "Lluvia helada" };
      case "mix":
        return { i: 5, en: "Rain/Snow", es: "Lluvia/Nieve" };
      case "snow":
        if (o.flurry) return { i: 13, en: "Flurries", es: "Ráfagas de nieve" };
        if (o.heavy) return { i: 42, en: "Heavy Snow", es: "Nevada fuerte" };
        if (o.scattered) return { i: isDay ? 41 : 46, en: "Scattered Snow Showers", es: "Chubascos de nieve dispersos" };
        if (o.showers) return { i: 14, en: "Snow Showers", es: "Chubascos de nieve" };
        if (o.light) return { i: 14, en: "Light Snow", es: "Nevada ligera" };
        return { i: 16, en: "Snow", es: "Nieve" };
      default: // rain
        if (o.heavy) return { i: 40, en: "Heavy Rain", es: "Lluvia fuerte" };
        if (o.drizzle) return { i: 9, en: "Drizzle", es: "Llovizna" };
        if (o.scattered) return { i: isDay ? 39 : 45, en: "Scattered Showers", es: "Chubascos dispersos" };
        if (o.showers) return { i: 11, en: "Showers", es: "Chubascos" };
        if (o.light) return { i: 11, en: "Light Rain", es: "Lluvia ligera" };
        return { i: 12, en: "Rain", es: "Lluvia" };
    }
  }

  // single WMO weather code (used for "current conditions")
  function condFromCode(code, cover, isDay) {
    if (code <= 3) {
      var c = (cover != null && !isNaN(cover)) ? cover : [5, 22, 50, 100][code];
      return skyFromCover(c, isDay);
    }
    if (code === 45 || code === 48) return { i: 20, en: "Fog", es: "Niebla" };
    switch (code) {
      case 51: case 53: case 55: return precipCond("rain", { drizzle: true }, isDay);
      case 56: case 57: return precipCond("freezing", { drizzle: true }, isDay);
      case 61: return precipCond("rain", { light: true }, isDay);
      case 63: return precipCond("rain", {}, isDay);
      case 65: return precipCond("rain", { heavy: true }, isDay);
      case 66: case 67: return precipCond("freezing", {}, isDay);
      case 71: return precipCond("snow", { light: true }, isDay);
      case 73: return precipCond("snow", {}, isDay);
      case 75: return precipCond("snow", { heavy: true }, isDay);
      case 77: return precipCond("snow", { flurry: true }, isDay);
      case 80: return precipCond("rain", { scattered: true }, isDay);
      case 81: return precipCond("rain", { showers: true }, isDay);
      case 82: return precipCond("rain", { heavy: true }, isDay);
      case 85: return precipCond("snow", { scattered: true }, isDay);
      case 86: return precipCond("snow", { showers: true }, isDay);
      case 95: return precipCond("thunder", {}, isDay);
      case 96: case 99: return precipCond("thunder", { hail: true }, isDay);
    }
    return skyFromCover(50, isDay);
  }

  // a 12-hour window of hourly rows -> one condition (for day/night "dayparts")
  function windowCond(rows, isDay) {
    var n = rows.length;
    if (!n) return { i: 44, en: "Not Available", es: "No disponible" };
    var maxPop = 0, i;
    for (i = 0; i < n; i++) if ((rows[i].pop || 0) > maxPop) maxPop = rows[i].pop;
    var precip = rows.filter(function (r) { return r.code >= 51; });
    if (maxPop < 25 && precip.length < n * 0.3) precip = []; // model noise
    if (!precip.length) {
      var fog = rows.filter(function (r) { return r.code === 45 || r.code === 48; }).length;
      if (fog >= n / 2) return { i: 20, en: "Fog", es: "Niebla" };
      var avg = rows.reduce(function (s, r) { return s + (r.cover == null ? 50 : r.cover); }, 0) / n;
      return skyFromCover(avg, isDay);
    }
    var codes = precip.map(function (r) { return r.code; });
    var has = function (arr) { return codes.some(function (c) { return arr.indexOf(c) > -1; }); };
    var all = function (arr) { return codes.every(function (c) { return arr.indexOf(c) > -1; }); };
    var frac = precip.length / n;
    var thunder = codes.some(function (c) { return c >= 95; });
    var freezing = has([56, 57, 66, 67]);
    var snow = has([71, 73, 75, 77, 85, 86]);
    var rain = has([51, 53, 55, 61, 63, 65, 80, 81, 82]);
    if (thunder) return precipCond("thunder", { hail: has([96, 99]), isolated: frac < 0.2, scattered: frac < 0.5 }, isDay);
    if (freezing) return precipCond("freezing", { drizzle: all([56, 57]) }, isDay);
    if (snow && rain) return precipCond("mix", {}, isDay);
    if (snow) return precipCond("snow", { heavy: has([75, 86]), flurry: all([77]), scattered: frac < 0.5, light: all([71, 85]) }, isDay);
    return precipCond("rain", { heavy: has([65, 82]), drizzle: all([51, 53, 55]), scattered: frac < 0.5, light: all([61, 80]) }, isDay);
  }

  var CARD_EN = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  var CARD_ES = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"];
  function cardinal(deg, es) {
    var i = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
    return (es ? CARD_ES : CARD_EN)[i];
  }
  function uvDesc(v) {
    if (v < 3) return "Low";
    if (v < 6) return "Moderate";
    if (v < 8) return "High";
    if (v < 11) return "Very High";
    return "Extreme";
  }

  /* ------------------------------------------------------------------ */
  /* Open-Meteo access                                                   */
  /* ------------------------------------------------------------------ */
  var UNITS = "&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto";

  function omCurrentMany(lats, lons) {
    var key = "cur:" + lats.join(",") + "|" + lons.join(",");
    return cached(key, 4 * 60 * 1000, function () {
      var url = OM_FORECAST + "?latitude=" + lats.join(",") + "&longitude=" + lons.join(",") +
        "&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m" + UNITS;
      return fetchJSON(url).then(function (res) { return Array.isArray(res) ? res : [res]; });
    });
  }

  function omForecast(lat, lon) {
    var key = "fc:" + num(lat).toFixed(3) + "," + num(lon).toFixed(3);
    return cached(key, 10 * 60 * 1000, function () {
      var url = OM_FORECAST + "?latitude=" + lat + "&longitude=" + lon +
        "&hourly=temperature_2m,weather_code,cloud_cover,precipitation_probability,wind_speed_10m,wind_direction_10m,uv_index" +
        "&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min&forecast_days=8" + UNITS;
      return fetchJSON(url);
    });
  }

  function obsFromOM(om, es) {
    var c = om.current;
    var isDay = c.is_day === 1;
    var cond = condFromCode(c.weather_code, c.cloud_cover, isDay);
    var ws = round(c.wind_speed_10m) || 0;
    var gust = round(c.wind_gusts_10m);
    return {
      temperature: round(c.temperature_2m),
      temperatureFeelsLike: round(c.apparent_temperature),
      relativeHumidity: round(c.relative_humidity_2m),
      iconCode: cond.i,
      wxPhraseLong: es ? cond.es : cond.en,
      pressureAltimeter: +(c.pressure_msl * 0.02953).toFixed(2),
      windSpeed: ws,
      windGust: (gust != null && gust >= 15 && gust >= ws + 6) ? gust : null,
      windDirection: c.wind_direction_10m,
      windDirectionCardinal: ws === 0 ? (es ? "CALMA" : "CALM") : cardinal(c.wind_direction_10m, es),
      dayOrNight: isDay ? "D" : "N",
      cloudCover: c.cloud_cover
    };
  }

  // ---- daily/daypart forecast in the TWC "5day" response shape ----
  var DAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var DAYS_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

  function dayIndexOf(dateStr) { return new Date(dateStr + "T12:00:00Z").getUTCDay(); }

  function windVector(rows) {
    var sx = 0, sy = 0;
    rows.forEach(function (r) {
      var a = (r.wdir || 0) * Math.PI / 180, w = r.wspd || 0;
      sx += w * Math.sin(a); sy += w * Math.cos(a);
    });
    var deg = (Math.atan2(sx, sy) * 180 / Math.PI + 360) % 360;
    return deg;
  }

  function buildNarrative(cond, isDay, temp, dirCard, avgWind, pop, es) {
    var s = (es ? cond.es : cond.en) + ". ";
    s += es ? (isDay ? "Máxima " : "Mínima ") : (isDay ? "High " : "Low ");
    s += (temp == null ? "--" : temp) + "F. ";
    if (avgWind < 5) {
      s += es ? "Vientos ligeros y variables." : "Winds light and variable.";
    } else {
      var lo = Math.max(5, Math.round(avgWind / 5) * 5);
      s += es ? "Vientos del " + dirCard + " a " + lo + " a " + (lo + 5) + " mph."
              : "Winds " + dirCard + " at " + lo + " to " + (lo + 5) + " mph.";
    }
    if (pop >= 20) {
      var p = Math.round(pop / 10) * 10;
      s += es ? " Probabilidad de precipitación " + p + "%." : " Chance of precipitation " + p + "%.";
    }
    return s;
  }

  function buildForecast(om, lang) {
    var es = isEs(lang);
    var off = om.utc_offset_seconds || 0;
    var offS = offsetStr(off);
    var h = om.hourly;
    var rows = [], byDate = {};
    for (var i = 0; i < h.time.length; i++) {
      var t = h.time[i];
      var r = {
        date: t.slice(0, 10), hr: parseInt(t.slice(11, 13), 10), temp: h.temperature_2m[i],
        code: h.weather_code[i], cover: h.cloud_cover[i], pop: h.precipitation_probability[i],
        wspd: h.wind_speed_10m[i], wdir: h.wind_direction_10m[i]
      };
      rows.push(r);
      (byDate[r.date] = byDate[r.date] || []).push(r);
    }
    var dates = om.daily.time.slice(0, 7);
    var localNow = new Date(Date.now() + off * 1000);
    var dayPassed = localNow.getUTCHours() >= 18;

    var out = {
      dayOfWeek: [], temperatureMax: [], temperatureMin: [], sunriseTimeLocal: [], sunsetTimeLocal: [],
      validTimeLocal: [], narrative: [],
      daypart: [{
        daypartName: [], dayOrNight: [], narrative: [], wxPhraseLong: [], iconCode: [],
        windSpeed: [], temperature: [], precipChance: [], windDirectionCardinal: []
      }]
    };
    var dp = out.daypart[0];

    function pushNull() {
      dp.daypartName.push(null); dp.dayOrNight.push(null); dp.narrative.push(null); dp.wxPhraseLong.push(null);
      dp.iconCode.push(null); dp.windSpeed.push(null); dp.temperature.push(null); dp.precipChance.push(null);
      dp.windDirectionCardinal.push(null);
    }
    function pushPart(name, isDay, wrows) {
      if (!wrows.length) { pushNull(); dp.daypartName[dp.daypartName.length - 1] = name; return null; }
      var cond = windowCond(wrows, isDay);
      var temps = wrows.map(function (x) { return x.temp; });
      var temp = round(isDay ? Math.max.apply(null, temps) : Math.min.apply(null, temps));
      var avgW = wrows.reduce(function (s, x) { return s + (x.wspd || 0); }, 0) / wrows.length;
      var dirCard = cardinal(windVector(wrows), es);
      var pop = Math.max.apply(null, wrows.map(function (x) { return x.pop || 0; }));
      var narr = buildNarrative(cond, isDay, temp, dirCard, avgW, pop, es);
      dp.daypartName.push(name); dp.dayOrNight.push(isDay ? "D" : "N"); dp.narrative.push(narr);
      dp.wxPhraseLong.push(es ? cond.es : cond.en); dp.iconCode.push(cond.i); dp.windSpeed.push(Math.round(avgW));
      dp.temperature.push(temp); dp.precipChance.push(Math.round(pop / 5) * 5); dp.windDirectionCardinal.push(dirCard);
      return { narr: narr, temp: temp };
    }

    for (var d = 0; d < dates.length; d++) {
      var date = dates[d];
      var dow = dayIndexOf(date);
      var dayName = es ? DAYS_ES[dow] : DAYS_EN[dow];
      var todayRows = byDate[date] || [];
      var dayRows = todayRows.filter(function (x) { return x.hr >= 7 && x.hr <= 18; });
      var nextDate = new Date(new Date(date + "T12:00:00Z").getTime() + 86400000).toISOString().slice(0, 10);
      var nightRows = todayRows.filter(function (x) { return x.hr >= 19; })
        .concat((byDate[nextDate] || []).filter(function (x) { return x.hr <= 6; }));

      out.dayOfWeek.push(dayName);
      out.validTimeLocal.push(date + "T07:00:00" + offS);
      out.sunriseTimeLocal.push(om.daily.sunrise[d] ? om.daily.sunrise[d] + ":00" + offS : null);
      out.sunsetTimeLocal.push(om.daily.sunset[d] ? om.daily.sunset[d] + ":00" + offS : null);

      var skipDay = (d === 0 && dayPassed);
      var nightTemps = nightRows.map(function (x) { return x.temp; });
      out.temperatureMax.push(skipDay ? null : round(om.daily.temperature_2m_max[d]));
      out.temperatureMin.push(nightTemps.length ? round(Math.min.apply(null, nightTemps)) : round(om.daily.temperature_2m_min[d]));

      var dayName1 = d === 0 ? (es ? "Hoy" : "Today") : dayName;
      var nightName = d === 0 ? (es ? "Esta noche" : "Tonight") : (es ? dayName + " por la noche" : dayName + " night");
      var dr = null;
      if (skipDay) pushNull(); else dr = pushPart(dayName1, true, dayRows);
      var nr = pushPart(nightName, false, nightRows);
      out.narrative.push((dr && dr.narr) || (nr && nr.narr) || null);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* geocoding helpers                                                   */
  /* ------------------------------------------------------------------ */
  var placeCache = {}; // "lat,lon" -> {name,state,stateFull}

  function reverseGeocode(lat, lon) {
    var k = placeKey(lat, lon);
    if (placeCache[k]) return Promise.resolve(placeCache[k]);
    return cached("rev:" + k, 24 * 3600 * 1000, function () {
      var url = BDC_REVERSE + "?latitude=" + lat + "&longitude=" + lon + "&localityLanguage=en";
      return fetchJSON(url, 5000).then(function (d) {
        var sub = d.principalSubdivision || "";
        var code = (d.principalSubdivisionCode || "").split("-")[1] || US_STATES[sub] || "";
        var res = { name: d.city || d.locality || sub || "", state: code, stateFull: sub };
        placeCache[k] = res;
        return res;
      });
    });
  }

  function geocodeSearch(name, count, countryCode) {
    var url = OM_GEOCODE + "?name=" + encodeURIComponent(name) + "&count=" + (count || 5) + "&language=en&format=json" +
      (countryCode ? "&countryCode=" + countryCode : "");
    return cached("geo:" + url, 3600 * 1000, function () {
      return fetchJSON(url, 8000).then(function (d) {
        if (!d.results || !d.results.length) { var e = new Error("no geocode results"); e.status = 404; throw e; }
        return d.results;
      });
    });
  }

  function stateCode(r) {
    if (r.country_code === "US" || r.country_code === "PR") return US_STATES[r.admin1] || r.admin1 || "";
    return r.admin1 || r.country_code || "";
  }

  function locationObj(o) {
    return {
      location: {
        displayName: o.name || "", latitude: o.lat, longitude: o.lon,
        adminDistrictCode: o.state || "", adminDistrict: o.stateFull || STATE_BY_CODE[o.state] || o.state || "",
        city: o.name || "", ianaTimeZone: o.tz || "", airportName: o.airportName || "", iataCode: o.iata || "",
        countryCode: o.country || "US"
      }
    };
  }

  function findAirport(code) {
    code = String(code || "").toUpperCase();
    if (code.length === 4 && code[0] === "K") code = code.slice(1); // ICAO -> IATA for the lower 48
    for (var i = 0; i < AIRPORTS.length; i++) if (AIRPORTS[i].iata === code) return AIRPORTS[i];
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* ROUTES (each returns a Promise of the old weather.com JSON shape)   */
  /* ------------------------------------------------------------------ */
  var routes = {};

  // ---- /v3/location/point ----
  routes["/v3/location/point"] = function (q) {
    if (q.has("iataCode") || q.has("icaoCode")) {
      var ap = findAirport(q.get("iataCode") || q.get("icaoCode"));
      if (!ap) return Promise.reject(new Error("unknown airport code (add it to AIRPORTS in wxapi.js)"));
      return Promise.resolve(locationObj({ name: ap.name, lat: ap.lat, lon: ap.lon, state: ap.state, airportName: ap.name, iata: ap.iata }));
    }
    if (q.has("postalKey")) {
      var pk = q.get("postalKey").split(":");
      var cc = (pk[1] || "").toUpperCase();
      return geocodeSearch(pk[0], 10, cc || undefined).then(function (res) {
        var r = res[0];
        return locationObj({ name: r.name, lat: r.latitude, lon: r.longitude, state: stateCode(r), stateFull: r.admin1, tz: r.timezone, country: r.country_code });
      });
    }
    if (q.has("geocode")) {
      var g = parseGeocode(q.get("geocode"));
      var base = { lat: g.lat, lon: g.lon };
      var hit = placeCache[placeKey(g.lat, g.lon)];
      if (hit) return Promise.resolve(locationObj({ name: hit.name, lat: g.lat, lon: g.lon, state: hit.state, stateFull: hit.stateFull }));
      return reverseGeocode(g.lat, g.lon).then(function (p) {
        return locationObj({ name: p.name, lat: g.lat, lon: g.lon, state: p.state, stateFull: p.stateFull });
      }, function () {
        // reverse lookup unavailable: still return the coordinates so a config-supplied displayname keeps working
        return locationObj(base);
      });
    }
    return Promise.reject(new Error("unsupported location/point query"));
  };

  // ---- /v3/location/search (arrays, like TWC) ----
  routes["/v3/location/search"] = function (q) {
    var query = q.get("query") || "";
    var zip = /^\d{5}$/.test(query.trim());
    return geocodeSearch(query, 5, zip ? "US" : undefined).then(function (res) {
      var loc = { displayName: [], latitude: [], longitude: [], adminDistrictCode: [], adminDistrict: [], ianaTimeZone: [], countryCode: [] };
      res.forEach(function (r) {
        loc.displayName.push(r.name); loc.latitude.push(r.latitude); loc.longitude.push(r.longitude);
        loc.adminDistrictCode.push(stateCode(r)); loc.adminDistrict.push(r.admin1 || "");
        loc.ianaTimeZone.push(r.timezone || ""); loc.countryCode.push(r.country_code || "");
      });
      return { location: loc };
    });
  };

  // ---- /v3/location/near ----
  function nearTowns(lat, lon) {
    return cached("near:" + lat.toFixed(2) + "," + lon.toFixed(2), 3600 * 1000, function () {
      var q = '[out:json][timeout:10];node(around:70000,' + lat + ',' + lon + ')[place~"^(city|town)$"][name];out 80;';
      return fetchJSON(OVERPASS + "?data=" + encodeURIComponent(q), 12000).then(function (d) {
        var els = (d.elements || []).filter(function (e) { return e.tags && e.tags.name; });
        if (!els.length) throw new Error("no towns");
        return reverseGeocode(lat, lon).catch(function () { return { state: "", stateFull: "" }; }).then(function (home) {
          return els.map(function (e) {
            return { name: e.tags.name, lat: e.lat, lon: e.lon, state: home.state, stateFull: home.stateFull,
                     big: e.tags.place === "city" };
          });
        });
      }).catch(function () {
        return CITIES.map(function (c) { return { name: c.name, lat: c.lat, lon: c.lon, state: c.state, stateFull: STATE_BY_CODE[c.state] || "" }; });
      });
    });
  }

  routes["/v3/location/near"] = function (q) {
    var g = parseGeocode(q.get("geocode"));
    var product = q.get("product");
    if (product === "airport") {
      var list = AIRPORTS.map(function (a) { return { a: a, d: haversineKm(g.lat, g.lon, a.lat, a.lon) }; })
        .sort(function (x, y) { return x.d - y.d; }).slice(0, 8);
      return Promise.resolve({ location: {
        latitude: list.map(function (x) { return x.a.lat; }), longitude: list.map(function (x) { return x.a.lon; }),
        airportName: list.map(function (x) { return x.a.name; }), iataCode: list.map(function (x) { return x.a.iata; }),
        stationName: list.map(function (x) { return x.a.name; })
      } });
    }
    // observation stations -> we hand back nearby towns instead (nearest first)
    return nearTowns(g.lat, g.lon).then(function (towns) {
      var homeName = (window.locationConfig && window.locationConfig.mainCity && window.locationConfig.mainCity.displayname) || "";
      var seen = {};
      var list = towns.map(function (t) { return { t: t, d: haversineKm(g.lat, g.lon, t.lat, t.lon) }; })
        .filter(function (x) { return x.d > 3; })
        .sort(function (x, y) { return x.d - y.d; })
        .filter(function (x) { var k = x.t.name.toLowerCase(); if (seen[k]) return false; seen[k] = 1; return true; })
        .slice(0, 11)
        .map(function (x) { return x.t; });
      // index 0 plays the role of the "station at the main city" (the app uses [1] as the extra city)
      var self = { name: homeName, lat: g.lat, lon: g.lon, state: "", stateFull: "" };
      var home = placeCache[placeKey(g.lat, g.lon)];
      if (home) { self.state = home.state; self.stateFull = home.stateFull; }
      var all = [self].concat(list);
      all.forEach(function (t) {
        if (!t.name) return; // don't cache an unknown name for the home point
        placeCache[placeKey(t.lat, t.lon)] = { name: t.name, state: t.state, stateFull: t.stateFull };
      });
      return { location: {
        latitude: all.map(function (t) { return t.lat; }), longitude: all.map(function (t) { return t.lon; }),
        stationName: all.map(function (t) { return t.name; })
      } };
    });
  };

  // ---- observations ----
  routes["/v3/wx/observations/current"] = function (q) {
    var g = parseGeocode(q.get("geocode")), es = isEs(q.get("language"));
    return omCurrentMany([g.lat], [g.lon]).then(function (arr) { return obsFromOM(arr[0], es); });
  };

  routes["/v3/aggcommon/v3-wx-observations-current"] = function (q) {
    var es = isEs(q.get("language"));
    var pts = (q.get("geocodes") || "").split(";").filter(function (s) { return s.trim(); }).map(parseGeocode);
    if (!pts.length) return Promise.resolve([]);
    return omCurrentMany(pts.map(function (p) { return p.lat; }), pts.map(function (p) { return p.lon; })).then(function (arr) {
      return arr.map(function (om) {
        var o = {}; o["v3-wx-observations-current"] = obsFromOM(om, es); return o;
      });
    });
  };

  // ---- forecast ----
  routes["/v3/wx/forecast/daily/5day"] = function (q) {
    var g = parseGeocode(q.get("geocode")), lang = q.get("language");
    return omForecast(g.lat, g.lon).then(function (om) { return buildForecast(om, lang); });
  };

  // ---- UV ----
  function nowIndex(om) {
    var off = om.utc_offset_seconds || 0;
    var ln = new Date(Date.now() + off * 1000);
    var key = ln.getUTCFullYear() + "-" + pad2(ln.getUTCMonth() + 1) + "-" + pad2(ln.getUTCDate()) + "T" + pad2(ln.getUTCHours()) + ":00";
    var idx = om.hourly.time.indexOf(key);
    return idx < 0 ? 0 : idx;
  }
  routes["/v2/indices/uv/current"] = function (q) {
    var g = parseGeocode(q.get("geocode"));
    return omForecast(g.lat, g.lon).then(function (om) {
      var v = om.hourly.uv_index[nowIndex(om)] || 0;
      return { uvIndexCurrent: { uvIndex: Math.round(v), uvDesc: uvDesc(v) } };
    });
  };
  routes["/v2/indices/uv/hourly/48hour"] = function (q) {
    var g = parseGeocode(q.get("geocode"));
    return omForecast(g.lat, g.lon).then(function (om) {
      var start = nowIndex(om), offS = offsetStr(om.utc_offset_seconds || 0);
      var o = { fcstValidLocal: [], uvIndex: [], uvDesc: [] };
      for (var i = start; i < Math.min(start + 48, om.hourly.time.length); i++) {
        var v = om.hourly.uv_index[i] || 0;
        o.fcstValidLocal.push(om.hourly.time[i] + ":00" + offS);
        o.uvIndex.push(Math.round(v)); o.uvDesc.push(uvDesc(v));
      }
      return { uvIndex1hour: o };
    });
  };

  // ---- alerts (US National Weather Service) ----
  var alertCache = {};
  function sigOf(event) {
    if (/Warning$/.test(event)) return "W";
    if (/Watch$/.test(event)) return "A";
    if (/Advisory$/.test(event)) return "Y";
    return "S";
  }
  routes["/v3/alerts/headlines"] = function (q) {
    var g = parseGeocode(q.get("geocode"));
    var url = NWS + "/alerts/active?point=" + g.lat.toFixed(4) + "," + g.lon.toFixed(4);
    return fetchJSON(url, 10000, { "Accept": "application/geo+json" }).then(function (d) {
      var feats = (d.features || []).filter(function (f) { return f.properties && f.properties.status === "Actual"; });
      if (!feats.length) return undefined; // same as TWC's "204 no alerts"
      var alerts = feats.map(function (f) {
        alertCache[f.properties.id] = f.properties;
        return { detailKey: f.properties.id, eventDescription: f.properties.event, headlineText: f.properties.headline };
      });
      return { alerts: alerts };
    }, function (err) {
      if (err && (err.status === 400 || err.status === 404)) return undefined; // outside US coverage
      throw err;
    });
  };
  routes["/v3/alerts/detail"] = function (q) {
    var id = q.get("alertId");
    var get = alertCache[id] ? Promise.resolve(alertCache[id]) :
      fetchJSON(NWS + "/alerts/" + encodeURIComponent(id), 10000, { "Accept": "application/geo+json" }).then(function (f) { return f.properties; });
    return get.then(function (p) {
      var mt = { Alert: "New", Update: "Update", Cancel: "Cancel" }[p.messageType] || "New";
      return { alertDetail: {
        eventDescription: p.event, headlineText: p.headline || p.event, significance: sigOf(p.event),
        messageType: mt, texts: [{ description: (p.description || "") + (p.instruction ? "\n\n" + p.instruction : "") }]
      } };
    });
  };

  // ---- IP geolocation (replaces the paid pro.ip-api.com endpoint) ----
  function ipLookup() {
    return cached("ip", 3600 * 1000, function () {
      return fetchJSON("https://ipwho.is/", 6000).then(function (d) {
        if (d.success === false) throw new Error("ipwho.is failed");
        return { status: "success", city: d.city, lat: d.latitude, lon: d.longitude, region: d.region_code, regionName: d.region,
                 country: d.country, countryCode: d.country_code, timezone: d.timezone && d.timezone.id };
      }).catch(function () {
        return fetchJSON("https://get.geojs.io/v1/ip/geo.json", 6000).then(function (d) {
          return { status: "success", city: d.city, lat: parseFloat(d.latitude), lon: parseFloat(d.longitude),
                   region: US_STATES[d.region] || d.region, regionName: d.region, country: d.country, countryCode: d.country_code, timezone: d.timezone };
        });
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* $.getJSON interception                                              */
  /* ------------------------------------------------------------------ */
  var origGetJSON = $.getJSON;
  $.getJSON = function (url, data, success) {
    if (typeof url !== "string") return origGetJSON.apply($, arguments);
    var isTWC = /^https?:\/\/api\.weather\.com\//i.test(url);
    var isIP = /^https?:\/\/pro\.ip-api\.com\//i.test(url);
    if (!isTWC && !isIP) return origGetJSON.apply($, arguments);
    if (typeof data === "function") { success = data; data = undefined; }

    var promise;
    try {
      if (isIP) {
        promise = ipLookup();
      } else {
        var u = new URL(url);
        var handler = routes[u.pathname];
        promise = handler ? handler(u.searchParams) : Promise.reject(new Error("wxapi: unsupported endpoint " + u.pathname));
      }
    } catch (e) { promise = Promise.reject(e); }

    var d = $.Deferred();
    promise.then(function (res) {
      try { if (typeof success === "function") success(res, "success", d); }
      catch (e) { if (window.console) console.error("wxapi callback error:", e); }
      d.resolve(res);
    }, function (err) {
      if (window.console) console.warn("wxapi:", (err && err.message) || err);
      d.reject(err);
    });
    return d.promise();
  };

  window.wxapi = { routes: routes, buildForecast: buildForecast, obsFromOM: obsFromOM, condFromCode: condFromCode,
                   windowCond: windowCond, AIRPORTS: AIRPORTS };
})(window, jQuery);
