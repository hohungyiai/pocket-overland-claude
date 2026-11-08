// Pocket Overland: east Singapore (Pasir Ris, Pasir Ris Park, Tampines, Loyang edge)
// Paste into https://overpass-turbo.eu , press Run, then Export > Data > "raw OSM data" (JSON).
// Data (c) OpenStreetMap contributors, ODbL 1.0.
// bbox (S,W,N,E) = 1.335, 103.915, 1.400, 103.980
[out:json][timeout:180][bbox:1.335,103.915,1.400,103.980];
(
  way["highway"];
  nwr["landuse"];
  nwr["leisure"];
  nwr["natural"];
  way["waterway"];
  nwr["building"];
  way["railway"~"^(rail|subway|light_rail)$"];
  nwr["railway"="station"];
  nwr["public_transport"="station"];
  nwr["amenity"="parking"];
  relation["type"="multipolygon"]["landuse"];
  relation["type"="multipolygon"]["leisure"];
  relation["type"="multipolygon"]["natural"];
);
out body geom;
