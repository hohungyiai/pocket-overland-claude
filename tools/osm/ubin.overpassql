// Pocket Overland: Pulau Ubin (and Pulau Ketam), for the first off-road trail.
// Data (c) OpenStreetMap contributors, ODbL 1.0.
// bbox (S,W,N,E) = 1.390, 103.925, 1.430, 104.005
[out:json][timeout:180][bbox:1.390,103.925,1.430,104.005];
(
  way["highway"];
  nwr["landuse"];
  nwr["leisure"];
  nwr["natural"];
  nwr["place"];
  nwr["tourism"];
  nwr["amenity"];
  nwr["man_made"];
  way["waterway"];
  nwr["water"];
  nwr["building"];
  relation["type"="multipolygon"];
);
out body geom;
