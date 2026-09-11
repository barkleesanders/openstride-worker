(() => {
  const ratio = 1.609344;
  for (const select of document.querySelectorAll('select[name="distanceUnit"]')) {
    const inputs = select.form.querySelectorAll(
      'input[name="distanceKm"], input[name="actualKm"], input[name="currentWeeklyKm"], input[name="currentLongestKm"]',
    );
    let previous = 'mi';
    const outputs = new Map();
    for (const input of inputs) {
      const output = document.createElement('span');
      output.className = 'field-help';
      output.setAttribute('aria-live', 'polite');
      input.after(output);
      outputs.set(input, output);
    }
    function refresh(convert) {
      for (const input of inputs) {
        const value = input.valueAsNumber;
        if (convert && Number.isFinite(value)) {
          const km = value * (previous === 'mi' ? ratio : 1);
          input.value = String(
            Math.round((select.value === 'mi' ? km / ratio : km) * 10000) / 10000,
          );
        }
        const limit = input.name.startsWith('current') ? 100 : 300;
        input.max = String(
          select.value === 'mi' ? Math.round((limit / ratio) * 10000) / 10000 : limit,
        );
        const km = input.valueAsNumber * (select.value === 'mi' ? ratio : 1);
        outputs.get(input).textContent = Number.isFinite(km)
          ? `${Number((km / ratio).toFixed(2))} mi (${Number(km.toFixed(2))} km)`
          : 'Enter a distance in the selected unit.';
      }
      previous = select.value;
    }
    select.addEventListener('change', () => refresh(true));
    for (const input of inputs) input.addEventListener('input', () => refresh(false));
    refresh(false);
  }
})();
