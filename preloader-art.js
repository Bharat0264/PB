/* Independent groups keep the orbit, wing flaps and carried page easy to animate. */
window.PrintBeePreloaderArt = `
<svg class="pb-illustration" viewBox="0 0 360 300" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="pb-honey" x1="0" y1="0" x2=".8" y2="1" gradientUnits="objectBoundingBox">
      <stop stop-color="#FFE6A0"/><stop offset=".3" stop-color="#FFD263"/><stop offset=".67" stop-color="var(--pb-yellow, #F5B82E)"/><stop offset="1" stop-color="#D18A16"/>
    </linearGradient>
    <linearGradient id="pb-gold-edge" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#FFE7A1"/><stop offset=".4" stop-color="var(--pb-yellow, #F5B82E)"/><stop offset="1" stop-color="#BB7A11"/>
    </linearGradient>
    <radialGradient id="pb-face" cx=".32" cy=".23" r=".85">
      <stop stop-color="#FFE9A5"/><stop offset=".45" stop-color="#FFCF53"/><stop offset=".79" stop-color="var(--pb-yellow, #F5B82E)"/><stop offset="1" stop-color="#DB971E"/>
    </radialGradient>
    <linearGradient id="pb-charcoal" x1=".2" y1="0" x2=".9" y2="1">
      <stop stop-color="#69665C"/><stop offset=".4" stop-color="#4A4841"/><stop offset=".75" stop-color="var(--pb-charcoal, #3A3835)"/><stop offset="1" stop-color="#272622"/>
    </linearGradient>
    <radialGradient id="pb-cream" cx=".3" cy=".15" r=".95">
      <stop stop-color="#FFFEFA"/><stop offset=".48" stop-color="var(--pb-cream, #F4EFE4)"/><stop offset=".8" stop-color="#E5DCCA"/><stop offset="1" stop-color="#C9BCA2"/>
    </radialGradient>
    <linearGradient id="pb-paper-fill" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#FFFDF7"/><stop offset=".6" stop-color="var(--pb-cream, #F4EFE4)"/><stop offset="1" stop-color="#D8CEBA"/>
    </linearGradient>
    <radialGradient id="pb-eye" cx=".32" cy=".23" r=".9">
      <stop stop-color="#686457"/><stop offset=".5" stop-color="#383630"/><stop offset="1" stop-color="#211F1D"/>
    </radialGradient>
    <linearGradient id="pb-wing-vein" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#FFFFFF" stop-opacity=".1"/><stop offset="1" stop-color="#B8AA8D" stop-opacity=".5"/>
    </linearGradient>
    <filter id="pb-soft-shadow" x="-35%" y="-30%" width="175%" height="180%" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="5" stdDeviation="5" flood-color="#695630" flood-opacity=".17"/>
    </filter>
    <filter id="pb-small-shadow" x="-30%" y="-30%" width="165%" height="180%" color-interpolation-filters="sRGB">
      <feDropShadow dx="1" dy="2.5" stdDeviation="2" flood-color="#4A3721" flood-opacity=".2"/>
    </filter>
    <clipPath id="pb-body-clip"><ellipse rx="40" ry="60"/></clipPath>
  </defs>

  <g class="pb-orbit-yellow" fill="none" stroke-linecap="round" filter="url(#pb-small-shadow)">
    <path d="M143 38 C196 3 266 25 294 77 C323 132 305 201 260 233" stroke="url(#pb-gold-edge)" stroke-width="10"/>
  </g>
  <g class="pb-orbit-dark" fill="none" stroke-linecap="round">
    <path d="M260 233 C217 272 149 281 103 242 C92 232 84 222 78 211" stroke="url(#pb-charcoal)" stroke-width="8"/>
  </g>

  <g class="pb-bee-flight">
    <g class="pb-bee-pose">
    <g class="pb-bee-bob">
      <g fill="none" stroke="url(#pb-honey)" stroke-linecap="round">
        <path class="pb-speed" d="M88 177 Q73 173 59 177" stroke-width="7"/>
        <path class="pb-speed" d="M82 192 Q65 189 50 195" stroke-width="7"/>
        <path class="pb-speed" d="M82 207 Q72 204 63 208" stroke-width="6"/>
      </g>

      <g class="pb-wing" data-origin="151 145" filter="url(#pb-small-shadow)">
        <path d="M150 145 C140 126 123 101 119 76 C116 61 123 50 134 53 C158 59 166 95 158 132 Z" fill="url(#pb-cream)"/>
        <path d="M151 136 C148 113 145 83 132 66 C151 81 158 106 151 136Z" fill="url(#pb-wing-vein)"/>
      </g>
      <g class="pb-wing" data-origin="150 146" filter="url(#pb-small-shadow)">
        <path d="M149 144 C130 145 101 151 86 141 C73 133 77 120 90 117 C109 114 134 127 149 144Z" fill="url(#pb-cream)"/>
        <path d="M145 141 C120 139 107 134 91 130 C112 128 132 135 145 141Z" fill="url(#pb-wing-vein)"/>
      </g>
      <g class="pb-wing" data-origin="150 144" filter="url(#pb-small-shadow)">
        <path d="M150 145 C127 140 94 128 81 109 C68 91 74 71 92 66 C111 61 129 80 139 98 C147 112 150 129 150 145Z" fill="url(#pb-cream)"/>
        <path d="M146 137 C126 113 116 99 95 86 C112 105 128 122 146 137Z" fill="url(#pb-wing-vein)"/>
        <path d="M148 141 C126 128 109 120 91 115 C111 118 127 127 148 141Z" fill="url(#pb-wing-vein)"/>
        <path d="M82 86 C84 73 96 69 106 75" fill="none" stroke="#FFFDF5" stroke-width="3" stroke-linecap="round" opacity=".65"/>
      </g>

      <g transform="translate(145 190) rotate(36)" filter="url(#pb-soft-shadow)">
        <path d="M-9 52 L0 77 L11 51Z" fill="url(#pb-charcoal)"/>
        <ellipse rx="40" ry="60" fill="url(#pb-charcoal)"/>
        <g clip-path="url(#pb-body-clip)" fill="url(#pb-honey)">
          <path d="M-46 -51 Q0 -33 46 -51 L46 -31 Q0 -13 -46 -31Z"/>
          <path d="M-47 -13 Q0 8 47 -13 L47 9 Q0 30 -47 9Z"/>
          <path d="M-44 28 Q0 48 44 28 L44 47 Q0 69 -44 47Z"/>
        </g>
        <path d="M-25 -43 C-39 -18 -37 13 -24 36" fill="none" stroke="#FFF0C0" stroke-width="4" stroke-linecap="round" opacity=".15"/>
      </g>

      <g class="pb-paper" filter="url(#pb-soft-shadow)">
        <g transform="rotate(11 250 184)">
          <path d="M220 133 Q217 133 217 139 L217 228 Q217 233 222 233 L283 233 Q289 233 289 227 L289 153 L270 133Z" fill="#C5BBA6"/>
          <path d="M218 129 Q213 129 213 135 L213 225 Q213 230 219 230 L280 230 Q285 230 285 224 L285 150 L266 129Z" fill="url(#pb-paper-fill)"/>
          <path d="M266 129 L266 146 Q266 151 271 151 L285 151Z" fill="#FAF7EE" filter="url(#pb-small-shadow)"/>
          <path d="M218 137 L218 221" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" opacity=".65"/>
          <g fill="none" stroke="var(--pb-charcoal, #3A3835)" stroke-width="4.5" stroke-linecap="round">
            <path d="M225 158 H270"/><path d="M225 170 H268"/><path d="M225 182 H263"/><path d="M225 194 H252"/>
          </g>
          <g filter="url(#pb-small-shadow)">
            <rect class="pb-chip" x="224" y="207" width="10" height="11" rx="3" fill="#19BDDE"/>
            <rect class="pb-chip" x="237" y="207" width="10" height="11" rx="3" fill="#ED438D"/>
            <rect class="pb-chip" x="250" y="207" width="10" height="11" rx="3" fill="#F5C52F"/>
            <rect class="pb-chip" x="263" y="207" width="10" height="11" rx="3" fill="#3A3835"/>
          </g>
        </g>
      </g>

      <path d="M171 151 C174 165 188 181 204 183 C213 185 221 180 223 172" fill="none" stroke="#2F2D29" stroke-width="19" stroke-linecap="round"/>
      <path d="M171 148 C174 162 188 177 204 179 C212 180 218 177 220 171" fill="none" stroke="url(#pb-charcoal)" stroke-width="17" stroke-linecap="round"/>
      <ellipse cx="285" cy="182" rx="9" ry="13" transform="rotate(25 285 182)" fill="url(#pb-charcoal)" filter="url(#pb-small-shadow)"/>

      <g filter="url(#pb-soft-shadow)">
        <path d="M181 82 C178 59 184 46 197 42" fill="none" stroke="#282720" stroke-width="7.5" stroke-linecap="round"/>
        <path d="M181 78 C179 61 186 47 197 43" fill="none" stroke="#5B584A" stroke-width="4" stroke-linecap="round"/>
        <ellipse cx="199" cy="42" rx="8" ry="7" fill="url(#pb-charcoal)"/>
        <path d="M211 83 C218 63 228 57 237 59" fill="none" stroke="#302E28" stroke-width="7" stroke-linecap="round"/>
        <path d="M212 80 C220 65 229 59 236 60" fill="none" stroke="#625F50" stroke-width="3.5" stroke-linecap="round"/>
        <ellipse cx="239" cy="59" rx="7" ry="6.5" fill="url(#pb-charcoal)"/>
        <path d="M244 115 C245 141 226 161 201 161 C175 161 154 143 153 118 C151 91 169 73 193 72 C220 70 243 89 244 115Z" fill="url(#pb-face)"/>
        <path d="M162 105 C167 86 181 79 197 80" fill="none" stroke="#FFEDAC" stroke-width="4.5" stroke-linecap="round" opacity=".7"/>
        <ellipse cx="183" cy="110" rx="13" ry="16" transform="rotate(10 183 110)" fill="#C89D42" opacity=".4"/>
        <ellipse cx="217" cy="116" rx="11" ry="14" transform="rotate(10 217 116)" fill="#C89D42" opacity=".4"/>
        <ellipse cx="184" cy="108" rx="12" ry="15" transform="rotate(10 184 108)" fill="#FFFCF2"/>
        <ellipse cx="217" cy="114" rx="10" ry="13" transform="rotate(10 217 114)" fill="#FFFCF2"/>
        <ellipse cx="186" cy="109" rx="8.8" ry="11.7" transform="rotate(10 186 109)" fill="url(#pb-eye)"/>
        <ellipse cx="218" cy="115" rx="7.2" ry="10" transform="rotate(10 218 115)" fill="url(#pb-eye)"/>
        <ellipse cx="189" cy="103" rx="3.2" ry="4" fill="#FFFDF8"/>
        <ellipse cx="220" cy="110" rx="2.7" ry="3.4" fill="#FFFDF8"/>
        <ellipse cx="174" cy="129" rx="6.5" ry="3.3" fill="#EFA040" opacity=".45"/>
        <ellipse cx="227" cy="133" rx="5.5" ry="2.7" fill="#EFA040" opacity=".4"/>
        <path d="M188 131 Q201 139 215 132 C212 151 194 153 188 131Z" fill="#3C3028"/>
        <path d="M195 142 Q203 137 209 144 C204 150 198 149 195 142Z" fill="#F28266"/>
        <path d="M186 131 Q187 128 190 129" fill="none" stroke="#5C4322" stroke-width="2" stroke-linecap="round"/>
      </g>
    </g>
    </g>
  </g>
</svg>`;

window.PrintBeeTinyBeeArt = `
<svg viewBox="0 0 60 50" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="pb-tiny-gold" x2=".8" y2="1"><stop stop-color="#FFE8AA"/><stop offset=".5" stop-color="var(--pb-yellow, #F5B82E)"/><stop offset="1" stop-color="#D99A22"/></linearGradient>
    <linearGradient id="pb-tiny-ink" x2=".7" y2="1"><stop stop-color="#68645A"/><stop offset="1" stop-color="var(--pb-charcoal, #3A3835)"/></linearGradient>
    <linearGradient id="pb-tiny-cream" x2=".8" y2="1"><stop stop-color="#FFFEF9"/><stop offset="1" stop-color="#DED4BF"/></linearGradient>
    <clipPath id="pb-tiny-clip"><ellipse cx="28" cy="30" rx="17" ry="12"/></clipPath>
  </defs>
  <g class="pb-tiny-wing" data-origin="28 24"><ellipse cx="20" cy="16" rx="8" ry="13" transform="rotate(-35 20 16)" fill="url(#pb-tiny-cream)"/></g>
  <g class="pb-tiny-wing" data-origin="29 24"><ellipse cx="32" cy="13" rx="8" ry="12" transform="rotate(22 32 13)" fill="url(#pb-tiny-cream)"/></g>
  <path d="M13 29 L6 34 L14 37Z" fill="var(--pb-charcoal, #3A3835)"/>
  <ellipse cx="28" cy="30" rx="17" ry="12" fill="url(#pb-tiny-gold)"/>
  <g clip-path="url(#pb-tiny-clip)" fill="url(#pb-tiny-ink)"><path d="M16 17H22V44H16Z"/><path d="M29 17H35V44H29Z"/></g>
  <circle cx="43" cy="27" r="9" fill="url(#pb-tiny-gold)"/>
  <path d="M43 20 Q43 13 47 12" fill="none" stroke="#4D493F" stroke-width="2" stroke-linecap="round"/>
  <circle cx="47" cy="12" r="2.5" fill="url(#pb-tiny-ink)"/>
  <ellipse cx="46" cy="26" rx="2" ry="2.8" fill="#3A3835"/><circle cx="46.6" cy="25" r=".7" fill="#FFF"/>
  <path d="M44 31 Q47 33 49 30" fill="none" stroke="#735124" stroke-width="1.3" stroke-linecap="round"/>
</svg>`;
