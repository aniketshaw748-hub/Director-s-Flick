# Cost Model Reference — Higgsfield Generation Credits

This document serves as the single source of truth for generation costs measured during Phase 0 calibration (July 3, 2026).

---

## 1. Unit Pricing & Conversion

All API, CLI, and MCP generations on Higgsfield draw from a unified metered credit pool.
* **Credit Value**: **$0.06 per credit** (based on standard plan credit packages).
* **Unlimited Plan Perk**: Web-based "unlimited" generation benefits **never** apply to MCP, CLI, or API integrations. Every developer/subagent job is billed exactly according to usage.

---

## 2. Image Model Costs

Billing is a flat charge per successful generation. Elements-first generation (using Nano Banana 2 or Pro) allows multiple subjects and consistent characters.

| Model | Credits | Cost ($) | Element Support | Best Use Case |
|---|---|---|---|---|
| **soul_2** (2k) | **0.12** | $0.007 | No | Hero close-ups (high face fidelity) |
| **z_image** | **0.15** | $0.009 | No | Fast drafts / filler assets |
| **gpt_image_2-low** | **0.50** | $0.030 | Yes | Low-cost element-capable layouts |
| **seedream_v4_5 / v5_lite** | **1.00** | $0.060 | Yes | Stylized concept generation |
| **nano_banana** (budget) | **1.00** | $0.060 | Yes | General drafts |
| **nano_banana_2** (1k) | **1.50** | $0.090 | Yes | Workhorse for elements (internal ID: `nano_banana_flash`) |
| **nano_banana_pro** (1k) | **2.00** | $0.120 | Yes | Premium elements (4k resolution is **4.00 credits**) |
| **cinematic_studio_2_5** | **2.00** | $0.120 | Yes | Cinematic scenes |

---

## 3. Video Model Costs (16:9 Aspect Ratio)

Video pricing scales with duration. Standard models offer sound-off discounts at charge time (reconciled in the cost ledger).

| Model | Duration / Mode | Credits | Cost ($) | Notes / Recommendations |
|---|---|---|---|---|
| **kling2_6** | 5s silent | **5.00** | $0.300 | Cheap native 1080p, good identity holding |
| **kling3_0_turbo** | 3s–15s linear | **1.50 / sec** | $0.090 / sec | 3s = 4.5cr, 5s = 7.5cr, 10s = 15cr |
| **kling3_0_turbo** | 5s / 1080p | **10.00** | $0.600 | High-res budget option |
| **kling3_0** (std) | 5s silent | **6.25** | $0.375 | **Workhorse default**. Element-capable. Sound-off discount applied at charge. |
| **veo3_1_lite** | 4s silent | **4.00** | $0.240 | 1.00 cr/sec |
| **minimax_hailuo** | 6s | **6.00** | $0.360 | 1.00 cr/sec |
| **seedance_2_0_mini** | 5s | **12.50** | $0.750 | Budget identity-consistent generations |
| **seedance_2_0** | 5s standard | **22.50** | $1.350 | Premium identity-lock (fast mode is **17.50 credits**) |

---

## 4. Video Production Projections (~10-Minute Video, ~100 Shots)

The following tables outline projected costs to render a complete 10-minute video (~600 seconds of total footage, assuming 100 aligned shots).

### Option A: Kling 3.0 Standard Silent (Elements-First, Workhorse Default)
*Visual consistency locked via element tags in video prompts.*

* **Images** (100 stills @ `nano_banana_2`): 150.00 credits ($9.00)
* **Videos** (100 clips @ 6s average std silent): 750.00 credits ($45.00)
* **Total Estimated Cost**: **900.00 credits (~$54.00)**

### Option B: Kling 2.6 (Silent, Budget Option)
*Moderate visual consistency, fixed 5s clip chunks.*

* **Images** (100 stills @ `nano_banana_2`): 150.00 credits ($9.00)
* **Videos** (100 clips @ 5s Kling 2.6): 500.00 credits ($30.00)
* **Total Estimated Cost**: **650.00 credits (~$39.00)**

### Option C: Soul 2.0 + Kling 3.0 Std (Protag Hero close-ups)
*Uses Soul training for high face fidelity, single subject.*

* **Images** (100 stills @ `soul_2`): 12.00 credits ($0.72)
* **Videos** (100 clips @ 6s average std silent): 750.00 credits ($45.00)
* **Total Estimated Cost**: **762.00 credits (~$45.72)**
* *Caveat*: Soul models do not support Element prompt placeholders or multi-subject composition.
