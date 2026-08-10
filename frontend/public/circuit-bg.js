// Injects the same animated circuit background used across the React app
// (see components/CircuitBackground.tsx) into static pages under public/.
// Kept visually identical by hand — same paths, same 8 pulse routes, same
// 4-color palette. Pair with /circuit-bg.css.
(function () {
  var html =
    '<div class="circuit-background" aria-hidden="true">' +
    '<svg class="circuit-svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" role="presentation">' +
    '<defs><filter id="signalGlow" x="-70%" y="-70%" width="240%" height="240%">' +
    '<feGaussianBlur stdDeviation="3.2" result="blur" />' +
    '<feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>' +
    '</filter></defs>' +

    '<path class="trace" d="M0 105H145V165H250V226H355" />' +
    '<path class="trace soft" d="M0 210H92V278H182V338H285" />' +
    '<path class="trace" d="M60 0V74H210V124H315" />' +
    '<path class="trace soft" d="M305 0V70H405V135H500" />' +
    '<circle class="via" cx="145" cy="105" r="5" /><circle class="via-core" cx="145" cy="105" r="1.7" />' +
    '<circle class="via" cx="250" cy="165" r="5" /><circle class="via" cx="182" cy="278" r="4.5" /><circle class="via" cx="405" cy="70" r="4.5" />' +

    '<path class="trace" d="M1600 110H1470V168H1360V228H1250" />' +
    '<path class="trace soft" d="M1600 245H1510V310H1415V372H1325" />' +
    '<path class="trace" d="M1530 0V68H1430V120H1325" />' +
    '<path class="trace soft" d="M1265 0V80H1175V140H1080" />' +
    '<circle class="via" cx="1470" cy="110" r="5" /><circle class="via-core" cx="1470" cy="110" r="1.7" />' +
    '<circle class="via" cx="1360" cy="168" r="5" /><circle class="via" cx="1415" cy="310" r="4.5" /><circle class="via" cx="1175" cy="80" r="4.5" />' +

    '<path class="trace" d="M0 455H120V530H220V610H315" />' +
    '<path class="trace soft" d="M0 650H82V720H165V805H285" />' +
    '<path class="trace" d="M42 1000V900H125V830H205" />' +
    '<circle class="via" cx="120" cy="455" r="5" /><circle class="via" cx="220" cy="530" r="4.5" />' +
    '<circle class="via" cx="82" cy="650" r="4.5" /><circle class="via" cx="125" cy="900" r="5" />' +

    '<path class="trace" d="M1600 470H1490V545H1392V618H1295" />' +
    '<path class="trace soft" d="M1600 655H1515V730H1435V810H1320" />' +
    '<path class="trace" d="M1555 1000V910H1475V842H1390" />' +
    '<circle class="via" cx="1490" cy="470" r="5" /><circle class="via" cx="1392" cy="545" r="4.5" />' +
    '<circle class="via" cx="1515" cy="655" r="4.5" /><circle class="via" cx="1475" cy="910" r="5" />' +

    '<path class="trace" d="M0 930H165V865H280V805H390" />' +
    '<path class="trace soft" d="M270 1000V945H405V885H520" />' +
    '<circle class="via" cx="165" cy="930" r="5" /><circle class="via" cx="280" cy="865" r="4.5" /><circle class="via" cx="405" cy="945" r="4.5" />' +

    '<path class="trace" d="M1600 925H1450V868H1340V805H1230" />' +
    '<path class="trace soft" d="M1335 1000V948H1205V890H1090" />' +
    '<circle class="via" cx="1450" cy="925" r="5" /><circle class="via" cx="1340" cy="868" r="4.5" /><circle class="via" cx="1205" cy="948" r="4.5" />' +

    '<path class="trace soft desktop-only" d="M355 226H470V290H560" />' +
    '<path class="trace soft desktop-only" d="M1250 228H1130V290H1040" />' +
    '<path class="trace soft desktop-only" d="M315 610H410V680H510" />' +
    '<path class="trace soft desktop-only" d="M1295 618H1195V684H1090" />' +

    '<path class="trace" d="M0 320H95V260H190V195H295" />' +
    '<path class="trace soft" d="M0 380H70V440H150" />' +
    '<circle class="via" cx="95" cy="320" r="5" /><circle class="via" cx="190" cy="195" r="4.5" /><circle class="via" cx="70" cy="440" r="4.5" />' +

    '<path class="trace" d="M1600 320H1505V260H1410V195H1305" />' +
    '<path class="trace soft" d="M1600 380H1530V440H1450" />' +
    '<circle class="via" cx="1505" cy="320" r="5" /><circle class="via" cx="1410" cy="195" r="4.5" /><circle class="via" cx="1530" cy="440" r="4.5" />' +

    '<path class="trace" d="M700 0V60H620V110H540" />' +
    '<path class="trace soft desktop-only" d="M900 0V55H980V105H1060" />' +
    '<circle class="via" cx="620" cy="110" r="4.5" /><circle class="via" cx="980" cy="105" r="4.5" />' +

    '<path class="trace" d="M700 1000V940H620V890H540" />' +
    '<path class="trace soft" d="M900 1000V945H980V895H1060" />' +
    '<circle class="via" cx="620" cy="890" r="4.5" /><circle class="via" cx="980" cy="895" r="5" />' +

    '<path class="trace soft desktop-only" d="M20 150V400H55V650H20V1000" />' +
    '<path class="trace soft desktop-only" d="M1580 150V400H1545V650H1580V1000" />' +

    '<path class="pulse" pathLength="1000" d="M0 105H145V165H250V226H355" />' +
    '<circle class="confirmation-ring" cx="355" cy="226" r="8" /><circle class="confirmation-dot" cx="355" cy="226" r="2.4" />' +

    '<path class="pulse pulse-2 color-green" pathLength="1000" d="M1600 470H1490V545H1392V618H1295" />' +
    '<circle class="confirmation-ring ring-2 color-green" cx="1295" cy="618" r="8" /><circle class="confirmation-dot dot-2 color-green" cx="1295" cy="618" r="2.4" />' +

    '<path class="pulse pulse-3 color-teal" pathLength="1000" d="M0 930H165V865H280V805H390" />' +
    '<circle class="confirmation-ring ring-3 color-teal" cx="390" cy="805" r="8" /><circle class="confirmation-dot dot-3 color-teal" cx="390" cy="805" r="2.4" />' +

    '<path class="pulse pulse-4 color-violet desktop-only" pathLength="1000" d="M1600 245H1510V310H1415V372H1325" />' +
    '<circle class="confirmation-ring ring-4 color-violet desktop-only" cx="1325" cy="372" r="8" /><circle class="confirmation-dot dot-4 color-violet desktop-only" cx="1325" cy="372" r="2.4" />' +

    '<path class="pulse pulse-5" pathLength="1000" d="M0 320H95V260H190V195H295" />' +
    '<circle class="confirmation-ring ring-5" cx="295" cy="195" r="8" /><circle class="confirmation-dot dot-5" cx="295" cy="195" r="2.4" />' +

    '<path class="pulse pulse-6 color-green" pathLength="1000" d="M1600 320H1505V260H1410V195H1305" />' +
    '<circle class="confirmation-ring ring-6 color-green" cx="1305" cy="195" r="8" /><circle class="confirmation-dot dot-6 color-green" cx="1305" cy="195" r="2.4" />' +

    '<path class="pulse pulse-7 color-teal" pathLength="1000" d="M700 0V60H620V110H540" />' +
    '<circle class="confirmation-ring ring-7 color-teal" cx="540" cy="110" r="8" /><circle class="confirmation-dot dot-7 color-teal" cx="540" cy="110" r="2.4" />' +

    '<path class="pulse pulse-8 color-violet desktop-only" pathLength="1000" d="M900 1000V945H980V895H1060" />' +
    '<circle class="confirmation-ring ring-8 color-violet desktop-only" cx="1060" cy="895" r="8" /><circle class="confirmation-dot dot-8 color-violet desktop-only" cx="1060" cy="895" r="2.4" />' +

    '</svg></div>';

  document.body.insertAdjacentHTML("afterbegin", html);
})();
