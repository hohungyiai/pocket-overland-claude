// fetch v1
// Pocket Overland: the strip east of the first map (Changi Airport, Changi Coast Road, Changi Village, Changi Beach). For the East Coast and Changi rebuild plan.
// Data (c) OpenStreetMap contributors, ODbL 1.0.
// bbox (S,W,N,E) = 1.293, 103.980, 1.400, 104.045
[out:json][timeout:300][bbox:1.293,103.980,1.400,104.045];
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
