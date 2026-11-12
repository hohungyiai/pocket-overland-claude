// fetch v1
// Pocket Overland: east Singapore traffic lights (the same box as east-sg.overpassql).
// Only the signal points at junctions: a light for a pedestrian crossing alone
// (crossing=*, traffic_signals=crossing) is left out by the importer.
// Fetched by .github/workflows/osm-fetch.yml into data/osm/east-sg/signals.json.gz,
// beside the roads' own data, which it leaves untouched.
// Data (c) OpenStreetMap contributors, ODbL 1.0.
[out:json][timeout:120][bbox:1.335,103.915,1.400,103.980];
node["highway"="traffic_signals"];
out body;
