(function() {
  let isSpinning = false;
  let currentRotation = 0; // Track the total cumulative rotation
  let floatTweens = [];
  let boardIdleTween = null;
  let isSubmitting = false;
  let activePrize = null;

  // Auto-detect backend URL: use localhost for local testing, and production URL when deployed
  const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3000'
    : 'https://lush-backend-jwip.onrender.com';

  // Quadrants of the wheel, defined by angle range (0° = top, clockwise)
  const quadrants = [
    { page: 'page1_1', min: 0,   max: 90  }, // top-right quarter
    { page: 'page1_3', min: 90,  max: 180 }, // bottom-right quarter
    { page: 'page1_5', min: 180, max: 270 }, // bottom-left quarter
    { page: 'page1_2', min: 270, max: 360 }  // top-left quarter
  ];

  // We use event delegation on document to handle click/touch robustly,
  // in case GWD resets or recreates the page DOM.
  function initGlobalListeners() {
    var handled = false;

    // Spin board listeners
    document.addEventListener('touchend', function(e) {
      var tapArea = e.target.closest('#gwd-taparea_1');
      if (!tapArea) return;

      handled = true;
      e.preventDefault();
      
      var board = document.getElementById('Board');
      if (board && typeof gsap !== 'undefined') {
        spinWheel(board);
      }
      setTimeout(function() { handled = false; }, 400);
    }, { passive: false });

    document.addEventListener('click', function(e) {
      var tapArea = e.target.closest('#gwd-taparea_1');
      if (!tapArea) return;

      if (handled) return;
      
      var board = document.getElementById('Board');
      if (board && typeof gsap !== 'undefined') {
        spinWheel(board);
      }
    });

    // Form submit listeners
    document.addEventListener('touchend', function(e) {
      var submitBtn = e.target.closest('#gwd-taparea_submit');
      if (!submitBtn) return;

      e.preventDefault();
      handleFormSubmit();
    }, { passive: false });

    document.addEventListener('click', function(e) {
      var submitBtn = e.target.closest('#gwd-taparea_submit');
      if (!submitBtn) return;

      handleFormSubmit();
    });

    // Redirect buy now button listeners (on the thank you page)
    document.addEventListener('touchend', function(e) {
      var buyBtn = e.target.closest('#gwd-taparea_3');
      if (!buyBtn) return;

      e.preventDefault();
      window.open('https://nigeria.lushhairafrica.com/collections/hair-care', '_blank');
    }, { passive: false });

    document.addEventListener('click', function(e) {
      var buyBtn = e.target.closest('#gwd-taparea_3');
      if (!buyBtn) return;

      window.open('https://nigeria.lushhairafrica.com/collections/hair-care', '_blank');
    });
  }

  function startFloatingAnimations() {
    // Kill any existing floating tweens to avoid duplicates/leaks
    floatTweens.forEach(function(tween) {
      if (tween) tween.kill();
    });
    floatTweens = [];

    // The four decorative images on page1
    const elements = [
      { id: 'Layer_11', y: 6, x: 3, rot: 2, duration: 2.2 },
      { id: 'layer6', y: 8, x: -3, rot: -3, duration: 2.8 },
      { id: 'Layer_12', y: 5, x: 4, rot: 3, duration: 2.5 },
      { id: 'Layer_5_copy_2', y: 7, x: -2, rot: -2, duration: 3.0 }
    ];

    elements.forEach(function(item) {
      const el = document.getElementById(item.id);
      if (el && typeof gsap !== 'undefined') {
        gsap.set(el, { transformOrigin: '50% 50%' });
        
        const t = gsap.to(el, {
          y: '+=' + item.y,
          x: '+=' + item.x,
          rotation: '+=' + item.rot,
          duration: item.duration,
          repeat: -1,
          yoyo: true,
          ease: 'sine.inOut',
          delay: Math.random() * 0.5 // Desynchronize elements
        });
        floatTweens.push(t);
      }
    });
  }

  function startBoardIdleAnimation() {
    if (boardIdleTween) {
      boardIdleTween.kill();
      boardIdleTween = null;
    }

    const board = document.getElementById('Board');
    if (board && typeof gsap !== 'undefined') {
      // Set initial rotation offset to start the swing range properly
      gsap.set(board, { transformOrigin: '50% 50%', rotation: -12 });

      // Active left-to-right swing animation to make the wheel look engaging and interactive
      boardIdleTween = gsap.to(board, {
        rotation: 12,
        duration: 1.0,
        repeat: -1,
        yoyo: true,
        ease: 'sine.inOut'
      });
    }
  }

  function startAllAnimations() {
    startFloatingAnimations();
    startBoardIdleAnimation();
  }

  function spinWheel(board) {
    if (isSpinning) return;
    isSpinning = true;

    // Stop the board's idle animation so it doesn't conflict with the spin
    if (boardIdleTween) {
      boardIdleTween.kill();
      boardIdleTween = null;
    }

    // Immediately start a fast continuous spin animation to make the click feel instant
    const spinLoop = gsap.to(board, {
      rotation: '+=360',
      duration: 0.8,
      repeat: -1,
      ease: 'none',
      transformOrigin: '50% 50%'
    });

    // Call backend to select outcome dynamically (Option B)
    fetch(API_BASE + '/api/spin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
    .then(function(res) {
      return res.json();
    })
    .then(function(data) {
      // Stop the continuous looping spin
      spinLoop.kill();

      if (data.status !== 'success') {
        alert('Error initiating spin: ' + (data.message || 'unknown error'));
        isSpinning = false;
        startBoardIdleAnimation();
        return;
      }

      // Save verification payload in memory
      activePrize = {
        name: data.outcome,
        page: data.page,
        timestamp: data.timestamp,
        signature: data.signature
      };

      // Find the target quadrant matching the server's outcome
      const chosen = quadrants.find(function(q) {
        return q.page === data.page;
      });

      if (!chosen) {
        alert('Invalid quadrant page returned from server.');
        isSpinning = false;
        startBoardIdleAnimation();
        return;
      }

      // Read current rotation of the board
      const currentRot = gsap.getProperty(board, 'rotation') || 0;

      const targetAngle = chosen.min + Math.random() * (chosen.max - chosen.min);
      const currentFaceAngle = currentRot % 360;
      let diff = targetAngle - currentFaceAngle;
      if (diff <= 0) {
        diff += 360; // ensure clockwise rotation
      }

      const extraSpins = 3 * 360; // 3 full spins from current position
      currentRotation = currentRot + extraSpins + diff;

      // Reset scale to 1.0 and smoothly decelerate the board to its final target
      gsap.to(board, {
        scale: 1.0,
        rotation: currentRotation,
        duration: 3.5,
        ease: 'power3.out', // smooth ease out
        transformOrigin: '50% 50%',
        onComplete: function() {
          isSpinning = false;

          setTimeout(function() {
            if (window.gwd && window.gwd.actions && window.gwd.actions.gwdPagedeck) {
              window.gwd.actions.gwdPagedeck.goToPage('pagedeck', chosen.page, 'fade', 1000, 'linear', 'top');

              // Wait 1 second after the transition is complete (transition takes 1000ms, so 2000ms total)
              setTimeout(function() {
                if (chosen.page === 'page1_5') {
                  gwd.actions.gwdPagedeck.goToPage('pagedeck', 'page1', 'none', 1000, 'linear', 'top');
                  
                  // Restart all animations after returning to page1
                  setTimeout(startAllAnimations, 1050);
                } else {
                  // Direct to lead capture form page
                  gwd.actions.gwdPagedeck.goToPage('pagedeck', 'page1_4', 'none', 1000, 'linear', 'top');
                }
              }, 2000);
            }
          }, 800); // short pause after landing before navigating, so the result is visible
        }
      });
    })
    .catch(function(err) {
      spinLoop.kill();
      console.error('[Spin Fetch Error]:', err);
      alert('Could not reach the server. Please check your internet connection and try again.');
      isSpinning = false;
      startBoardIdleAnimation();
    });
  }

  function isValidNigerianPhone(phone) {
    var cleaned = String(phone).replace(/\D/g, '');
    if (cleaned.indexOf('2340') === 0) {
      return false;
    }
    if (cleaned.length === 11 && cleaned.charAt(0) === '0') {
      return true;
    }
    if (cleaned.length === 13 && cleaned.indexOf('234') === 0) {
      return cleaned.charAt(3) !== '0';
    }
    if (cleaned.length === 10 && cleaned.charAt(0) !== '0') {
      return true;
    }
    return false;
  }

  function handleFormSubmit() {
    if (isSubmitting) return;

    var nameEl = document.getElementById('nameInput');
    var phoneEl = document.getElementById('phonenumberInput');
    var emailEl = document.getElementById('emailInput');
    var locationEl = document.getElementById('locationInput');

    var name = nameEl ? nameEl.value.trim() : '';
    var phone = phoneEl ? phoneEl.value.trim() : '';
    var email = emailEl ? emailEl.value.trim() : '';
    var location = locationEl ? locationEl.value.trim() : '';

    if (!name || !phone || !location) {
      alert('Please fill in your Name, Phone Number, and Location!');
      return;
    }

    if (!isValidNigerianPhone(phone)) {
      alert('Please enter a valid Nigerian phone number.');
      return;
    }

    if (!activePrize) {
      alert('No active spin session found. Please spin the wheel first!');
      return;
    }

    isSubmitting = true;
    console.log('[Lush Claim]: Submitting claims data to backend...');

    var payload = {
      name: name,
      number: phone,
      email: email,
      city: location,
      prize: activePrize.name,
      timestamp: activePrize.timestamp,
      signature: activePrize.signature
    };

    fetch(API_BASE + '/api/claim-prize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(function(res) {
      return res.json();
    })
    .then(function(data) {
      isSubmitting = false;
      if (data.status === 'success') {
        alert('🎉 Reward Claimed Successfully! ' + data.message);
        
        // Open the Lush hair care store landing page in a new tab
        window.open('https://nigeria.lushhairafrica.com/collections/hair-care', '_blank');

        // Go to thank you page or final screen (page1_6 is a final screen in HTML!)
        if (window.gwd && window.gwd.actions && window.gwd.actions.gwdPagedeck) {
          window.gwd.actions.gwdPagedeck.goToPage('pagedeck', 'page1_6', 'fade', 1000, 'linear', 'top');
        }
      } else {
        alert('⚠️ ' + (data.message || 'Could not claim reward.'));
      }
    })
    .catch(function(err) {
      isSubmitting = false;
      console.error('[Claim Fetch Error]:', err);
      alert('Connection error. Please check your internet connection and try again.');
    });
  }

  function tryInit() {
    const tapArea = document.getElementById('gwd-taparea_1');
    const board = document.getElementById('Board');

    if (!tapArea || !board || typeof gsap === 'undefined') {
      setTimeout(tryInit, 50);
      return;
    }

    // Start all idle animations on initial load
    startAllAnimations();
  }

  // Start initialization
  initGlobalListeners();
  tryInit();
})();