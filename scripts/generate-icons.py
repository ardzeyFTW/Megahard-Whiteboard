#!/usr/bin/env python3
"""Generates multi-resolution icon.ico and icon.png matching public/icon.svg."""
import os
import numpy as np
from PIL import Image, ImageDraw

def generate_icons():
    S = 64
    W = 32 * S  # 2048x2048 canvas for super-sampled anti-aliasing
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 1. Rounded rectangle with corner radius 8 * 64 = 512
    draw.rounded_rectangle([0, 0, W, W], radius=8 * S, fill='#2f6fde')

    # 2. Cubic Bezier curve matching SVG path:
    # M 8 21 c 3 -7, 6 -9, 8 -5 s 4 3, 8 -5
    p0 = np.array([8.0 * S, 21.0 * S])
    p1 = np.array([11.0 * S, 14.0 * S])
    p2 = np.array([14.0 * S, 12.0 * S])
    p3 = np.array([16.0 * S, 16.0 * S])

    # Reflected control point for 's' command: p4 = 2*p3 - p2
    p4 = 2 * p3 - p2
    p5 = np.array([20.0 * S, 19.0 * S])
    p6 = np.array([24.0 * S, 11.0 * S])

    def bezier(p0, p1, p2, p3, steps=250):
        t = np.linspace(0, 1, steps)[:, None]
        return (1 - t)**3 * p0 + 3 * (1 - t)**2 * t * p1 + 3 * (1 - t) * t**2 * p2 + t**3 * p3

    curve = np.vstack([bezier(p0, p1, p2, p3), bezier(p3, p4, p5, p6)])
    stroke_width = int(round(2.6 * S))
    pts = [tuple(pt) for pt in curve]

    draw.line(pts, fill='#ffffff', width=stroke_width, joint='curve')
    r_cap = stroke_width / 2.0
    draw.ellipse([p0[0] - r_cap, p0[1] - r_cap, p0[0] + r_cap, p0[1] + r_cap], fill='#ffffff')
    draw.ellipse([p6[0] - r_cap, p6[1] - r_cap, p6[0] + r_cap, p6[1] + r_cap], fill='#ffffff')

    # 3. Yellow circular stamp at cx=24, cy=11, r=2
    cx, cy, cr = 24.0 * S, 11.0 * S, 2.0 * S
    draw.ellipse([cx - cr, cy - cr, cx + cr, cy + cr], fill='#ffd34d')

    # Downsample to 512x512
    img512 = img.resize((512, 512), Image.Resampling.LANCZOS)

    script_dir = os.path.dirname(os.path.abspath(__file__))
    root_dir = os.path.dirname(script_dir)
    build_dir = os.path.join(root_dir, 'build')
    public_dir = os.path.join(root_dir, 'public')
    os.makedirs(build_dir, exist_ok=True)
    os.makedirs(public_dir, exist_ok=True)

    img512.save(os.path.join(build_dir, 'icon.png'), format='PNG')
    img512.save(os.path.join(public_dir, 'icon.png'), format='PNG')

    # Multi-resolution Windows ICO
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    img512.save(os.path.join(build_dir, 'icon.ico'), format='ICO', sizes=ico_sizes)
    print('Generated build/icon.ico, build/icon.png, and public/icon.png successfully!')

if __name__ == '__main__':
    generate_icons()
