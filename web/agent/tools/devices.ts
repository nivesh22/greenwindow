// Curated device table (design §7.5). A TS module, not JSON: Node ESM on Vercel needs import attributes for JSON.
export const DEVICES_DATA = {
  "version": 1,
  "pue_default": 1.2,
  "gpu_host_overhead_kw_per_8": 0.3,
  "devices": [
    {
      "id": "ev_7kw",
      "category": "ev",
      "name": "Home EV charger (7 kW)",
      "aliases": [
        "ev",
        "electric car",
        "car",
        "charge my car",
        "tesla",
        "home charger"
      ],
      "kw": 7,
      "typical_hours": 6,
      "source": "UK home wallbox rating, 7.4 kW single phase (32 A at 230 V); typical 40 kWh session (assumed)",
      "assumed": true
    },
    {
      "id": "ev_3_7kw",
      "category": "ev",
      "name": "Portable EV charger on a 3-pin socket (3.7 kW)",
      "aliases": [
        "ev slow",
        "granny charger",
        "portable charger",
        "16a charger"
      ],
      "kw": 3.7,
      "typical_hours": 10,
      "source": "UK 16 A single-phase charger rating, 3.7 kW (assumed)",
      "assumed": true
    },
    {
      "id": "dishwasher",
      "category": "appliance",
      "name": "Dishwasher",
      "aliases": [
        "dish washer",
        "dishes"
      ],
      "kw": 1.2,
      "typical_hours": 2,
      "source": "typical UK appliance rating; cycle-average power (assumed)",
      "assumed": true
    },
    {
      "id": "washing_machine",
      "category": "appliance",
      "name": "Washing machine",
      "aliases": [
        "washer",
        "laundry",
        "wash"
      ],
      "kw": 0.5,
      "typical_hours": 2,
      "source": "typical UK appliance rating; cycle-average power (assumed)",
      "assumed": true
    },
    {
      "id": "tumble_dryer",
      "category": "appliance",
      "name": "Tumble dryer (vented or condenser)",
      "aliases": [
        "dryer",
        "tumble drier",
        "clothes dryer"
      ],
      "kw": 2.5,
      "typical_hours": 2,
      "source": "typical UK appliance rating (about 2.5 kW element) (assumed)",
      "assumed": true
    },
    {
      "id": "heat_pump_dryer",
      "category": "appliance",
      "name": "Heat pump tumble dryer",
      "aliases": [
        "heat pump drier"
      ],
      "kw": 0.8,
      "typical_hours": 2.5,
      "source": "typical UK appliance rating; cycle-average power (assumed)",
      "assumed": true
    },
    {
      "id": "washer_dryer",
      "category": "appliance",
      "name": "Washer-dryer",
      "aliases": [
        "washer dryer",
        "wash and dry"
      ],
      "kw": 1.5,
      "typical_hours": 4,
      "source": "typical UK appliance rating; cycle-average power (assumed)",
      "assumed": true
    },
    {
      "id": "immersion_heater",
      "category": "heating",
      "name": "Immersion heater (3 kW)",
      "aliases": [
        "hot water",
        "water heater",
        "immersion",
        "hot water tank"
      ],
      "kw": 3,
      "typical_hours": 2,
      "source": "standard UK immersion element rating, 3 kW; duty (assumed)",
      "assumed": true
    },
    {
      "id": "heat_pump_boost",
      "category": "heating",
      "name": "Heat pump hot-water boost",
      "aliases": [
        "heat pump",
        "hot water boost",
        "legionella cycle"
      ],
      "kw": 2,
      "typical_hours": 2,
      "source": "typical domestic air-source heat pump electrical input (assumed)",
      "assumed": true
    },
    {
      "id": "electric_oven",
      "category": "appliance",
      "name": "Electric oven",
      "aliases": [
        "oven",
        "bake",
        "roast",
        "cooking"
      ],
      "kw": 2.2,
      "typical_hours": 1,
      "source": "typical UK appliance rating; thermostat-cycling average (assumed)",
      "assumed": true
    },
    {
      "id": "storage_heater",
      "category": "heating",
      "name": "Electric storage heater",
      "aliases": [
        "night storage heater",
        "economy 7 heater"
      ],
      "kw": 2.5,
      "typical_hours": 7,
      "source": "typical UK storage heater input rating (1.7 to 3.4 kW range); mid value (assumed)",
      "assumed": true
    },
    {
      "id": "e_bike",
      "category": "ev",
      "name": "E-bike battery charger",
      "aliases": [
        "ebike",
        "electric bike",
        "e bike"
      ],
      "kw": 0.1,
      "typical_hours": 5,
      "source": "typical e-bike charger input, about 100 W (assumed)",
      "assumed": true
    },
    {
      "id": "pool_pump",
      "category": "appliance",
      "name": "Swimming pool pump",
      "aliases": [
        "pool",
        "pump"
      ],
      "kw": 0.75,
      "typical_hours": 6,
      "source": "typical domestic pool pump rating (assumed)",
      "assumed": true
    },
    {
      "id": "hot_tub",
      "category": "heating",
      "name": "Hot tub heater",
      "aliases": [
        "hot tub",
        "spa",
        "jacuzzi"
      ],
      "kw": 3,
      "typical_hours": 4,
      "source": "typical 3 kW hot-tub heater element (assumed)",
      "assumed": true
    },
    {
      "id": "dehumidifier",
      "category": "appliance",
      "name": "Dehumidifier",
      "aliases": [
        "damp"
      ],
      "kw": 0.3,
      "typical_hours": 6,
      "source": "typical domestic compressor dehumidifier rating (assumed)",
      "assumed": true
    },
    {
      "id": "home_battery",
      "category": "storage",
      "name": "Home battery charging",
      "aliases": [
        "battery",
        "solar battery",
        "powerwall"
      ],
      "kw": 3.6,
      "typical_hours": 3,
      "source": "typical 3.6 kW home battery inverter limit (assumed)",
      "assumed": true
    },
    {
      "id": "gpu_a100_40",
      "category": "gpu",
      "name": "NVIDIA A100 40GB",
      "aliases": [
        "a100",
        "a100 40gb"
      ],
      "tdp_w": 400,
      "source": "NVIDIA A100 datasheet: 400 W TDP (SXM4); the PCIe variant is lower",
      "assumed": true
    },
    {
      "id": "gpu_a100_80",
      "category": "gpu",
      "name": "NVIDIA A100 80GB",
      "aliases": [
        "a100 80gb",
        "a100 80"
      ],
      "tdp_w": 400,
      "source": "NVIDIA A100 datasheet: 400 W TDP (SXM4); the PCIe variant is lower",
      "assumed": true
    },
    {
      "id": "gpu_h100_sxm",
      "category": "gpu",
      "name": "NVIDIA H100 SXM",
      "aliases": [
        "h100",
        "h100 sxm5"
      ],
      "tdp_w": 700,
      "source": "NVIDIA H100 datasheet: up to 700 W TDP (SXM)",
      "assumed": true
    },
    {
      "id": "gpu_h100_pcie",
      "category": "gpu",
      "name": "NVIDIA H100 PCIe",
      "aliases": [
        "h100 pcie"
      ],
      "tdp_w": 350,
      "source": "NVIDIA H100 datasheet: 350 W TDP (PCIe)",
      "assumed": true
    },
    {
      "id": "gpu_l4",
      "category": "gpu",
      "name": "NVIDIA L4",
      "aliases": [
        "l4"
      ],
      "tdp_w": 72,
      "source": "NVIDIA L4 datasheet: 72 W TDP",
      "assumed": true
    },
    {
      "id": "gpu_l40s",
      "category": "gpu",
      "name": "NVIDIA L40S",
      "aliases": [
        "l40s"
      ],
      "tdp_w": 350,
      "source": "NVIDIA L40S datasheet: 350 W TDP",
      "assumed": true
    },
    {
      "id": "gpu_t4",
      "category": "gpu",
      "name": "NVIDIA T4",
      "aliases": [
        "t4"
      ],
      "tdp_w": 70,
      "source": "NVIDIA T4 datasheet: 70 W TDP",
      "assumed": true
    },
    {
      "id": "gpu_rtx4090",
      "category": "gpu",
      "name": "NVIDIA GeForce RTX 4090",
      "aliases": [
        "rtx 4090",
        "4090",
        "geforce 4090"
      ],
      "tdp_w": 450,
      "source": "NVIDIA GeForce RTX 4090 specification: 450 W total graphics power",
      "assumed": true
    },
    {
      "id": "server_1u",
      "category": "server",
      "name": "Generic 1U server",
      "aliases": [
        "server",
        "rack server",
        "1u"
      ],
      "kw": 0.5,
      "typical_hours": null,
      "source": "typical dual-socket 1U server draw under load (assumed)",
      "assumed": true
    }
  ]
} as const
