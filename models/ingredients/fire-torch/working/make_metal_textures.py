"""Generate tileable metal textures for the fire_torch preview materials.

Run from this folder:  python3 make_metal_textures.py
Writes textures/torch_body_bronze.png, torch_cup_iron.png, torch_bracket_iron.png.
Deterministic (fixed seeds), so re-running reproduces the same images.
"""
import numpy as np
from PIL import Image

SIZE = 1024


def filtered_noise(rng, scale, stretch=1.0):
    """Tileable noise: white noise low-passed in the frequency domain.
    scale = feature size in pixels; stretch > 1 elongates features along x (brushed look)."""
    white = rng.standard_normal((SIZE, SIZE))
    fy = np.fft.fftfreq(SIZE)[:, None]
    fx = np.fft.fftfreq(SIZE)[None, :]
    r2 = (fx * stretch) ** 2 + fy ** 2
    sigma = 1.0 / (2 * np.pi * scale)
    out = np.real(np.fft.ifft2(np.fft.fft2(white) * np.exp(-r2 / (2 * sigma ** 2))))
    out -= out.mean()
    return out / (out.std() + 1e-9)


def hammered(rng, cell):
    """Soft dimples on a jittered grid (wraps at the edges)."""
    n = SIZE // cell
    y, x = np.mgrid[0:SIZE, 0:SIZE].astype(float)
    best = np.full((SIZE, SIZE), 1e9)
    pts = (np.stack(np.meshgrid(np.arange(n), np.arange(n)), -1).reshape(-1, 2) + rng.random((n * n, 2))) * cell
    for px, py in pts:
        dx = np.abs(x - px); dx = np.minimum(dx, SIZE - dx)
        dy = np.abs(y - py); dy = np.minimum(dy, SIZE - dy)
        best = np.minimum(best, dx * dx + dy * dy)
    d = np.sqrt(best) / cell
    return 1 - np.clip(d, 0, 1) ** 2  # 1 at dimple centres


def compose(base, tint, value):
    """value: luminance field around 1.0; tint: RGB 0..1."""
    rgb = np.clip(value[..., None] * np.array(base) * np.array(tint), 0, 1)
    return Image.fromarray((rgb * 255).round().astype(np.uint8), "RGB")


def bronze_body():
    rng = np.random.default_rng(11)
    blotch = filtered_noise(rng, 90)
    grain = filtered_noise(rng, 2.5)
    brushed = filtered_noise(rng, 3, stretch=0.06)  # long horizontal streaks
    dimples = hammered(rng, 64)
    value = 1 + 0.07 * blotch + 0.025 * grain + 0.10 * brushed - 0.22 * dimples
    # faint green-brown patina in the lowest spots of a finer blotch field
    fine = filtered_noise(rng, 30)
    patina = (np.clip(-fine - 1.4, 0, 0.6) * 0.5)[..., None] * np.array([-0.12, 0.03, 0.02])
    rgb = value[..., None] * np.array([0.72, 0.53, 0.32]) + patina
    return Image.fromarray((np.clip(rgb, 0, 1) * 255).round().astype(np.uint8), "RGB")


def iron(seed, base, scale_blotch, rust):
    rng = np.random.default_rng(seed)
    blotch = filtered_noise(rng, scale_blotch)
    grain = filtered_noise(rng, 2)
    brushed = filtered_noise(rng, 2.5, stretch=0.05)
    pits = filtered_noise(rng, 4)
    value = 1 + 0.08 * blotch + 0.025 * grain + 0.16 * brushed - 0.10 * np.clip(pits - 1.5, 0, 2)
    speck = filtered_noise(rng, 6) + 0.6 * filtered_noise(rng, 20)
    rust_mask = (np.clip(speck - 1.9, 0, 0.8) * 0.6)[..., None] * rust
    rgb = value[..., None] * np.array(base)
    rgb = rgb * (1 - rust_mask) + rust_mask * np.array([0.50, 0.30, 0.18])
    return Image.fromarray((np.clip(rgb, 0, 1) * 255).round().astype(np.uint8), "RGB")


if __name__ == "__main__":
    bronze_body().save("textures/torch_body_bronze.png", optimize=True)
    # cup: darker, slightly sooty iron, still mid-grey so detail stays visible
    iron(23, [0.42, 0.41, 0.40], 50, 0.5).save("textures/torch_cup_iron.png", optimize=True)
    # bracket: lighter wrought iron with a cool tint
    iron(37, [0.55, 0.56, 0.58], 70, 0.7).save("textures/torch_bracket_iron.png", optimize=True)
    for name in ("torch_body_bronze", "torch_cup_iron", "torch_bracket_iron"):
        a = np.asarray(Image.open(f"textures/{name}.png"), float) / 255
        lum = (a @ [0.2126, 0.7152, 0.0722]).mean()
        print(name, "mean luminance", round(lum, 3))
