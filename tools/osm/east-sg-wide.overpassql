// fetch v1
// Pocket Overland: east Singapore, wide (Pasir Ris and Tampines as before, plus
// East Coast Park, Bedok, Tanah Merah, Changi Airport, Changi Coast Road,
// Changi Village and Changi Beach). For the East Coast and Changi rebuild plan.
// Data (c) OpenStreetMap contributors, ODbL 1.0.
// bbox (S,W,N,E) = 1.293, 103.895, 1.400, 104.045
[out:json][timeout:300][maxsize:1073741824][bbox:1.293,103.895,1.400,104.045];
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
  nwr["aeroway"];
  way["man_made"="pier"];
  relation["type"="multipolygon"]["landuse"];
  relation["type"="multipolygon"]["leisure"];
  relation["type"="multipolygon"]["natural"];
);
out body geom;
