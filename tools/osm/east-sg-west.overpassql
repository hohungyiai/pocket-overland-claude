// fetch v1
// Pocket Overland: the sliver west of the first map (Bedok Reservoir, Hougang edge). For the East Coast and Changi rebuild plan.
// Data (c) OpenStreetMap contributors, ODbL 1.0.
// bbox (S,W,N,E) = 1.335, 103.895, 1.400, 103.915
[out:json][timeout:300][bbox:1.335,103.895,1.400,103.915];
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
