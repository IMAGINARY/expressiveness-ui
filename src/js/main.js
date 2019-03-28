// TODO: LeapMotion, MIDI slider, mouse, touch input
// TODO: Debug mode that shows LeapMotion interaction box and fps stats

// trail: http://www.subimago.com/?action=viewArticle&articleId=39
// https://github.com/leapmotion/leapjs-rigged-hand

(function () {
    const outputParameters = {
        tempo: createParameterModel('tempo', 0.5, {animate: false}),
        loudness: createParameterModel('loudness', 0.5, {animate: false}),
        impact: createParameterModel('impact', 0.5, {animate: false}),
    };
    const inputParameters = {
        mlTempo: createParameterModel('mlTempo', 0.5, {animate: true}),
        mlLoudness: createParameterModel('mlLoudness', 0.5, {animate: true}),
        mlMicroTiming: createParameterModel('mlMicroTiming', 0.5, {animate: true}),
        mlDynamicSpread: createParameterModel('mlDynamicSpread', 0.5, {animate: true}),
        mlArticulation: createParameterModel('mlArticulation', 0.5, {animate: true}),
    };

    // attach range callbacks to parameters
    {
        const fullRangeCallback = () => {
            return {min: 0, max: 1};
        };
        outputParameters.loudness.userData.rangeCallback = fullRangeCallback;
        outputParameters.tempo.userData.rangeCallback = fullRangeCallback;
        outputParameters.impact.userData.rangeCallback = fullRangeCallback;

        inputParameters.mlLoudness.userData.rangeCallback = () => {
            const ml = outputParameters.impact.value;
            return {
                min: outputParameters.loudness.value * (1 - ml),
                max: outputParameters.loudness.value,
            }
        };

        inputParameters.mlTempo.userData.rangeCallback = () => {
            const ml = outputParameters.impact.value;
            return {
                min: outputParameters.tempo.value * (1 - ml),
                max: outputParameters.tempo.value,
            }
        };

        const mlRangeCallback = () => {
            const ml = outputParameters.impact.value;
            return {
                min: 0.5 * (1 - ml),
                max: 0.5 * (1 + ml),
            }
        };
        inputParameters.mlDynamicSpread.userData.rangeCallback = mlRangeCallback;
        inputParameters.mlMicroTiming.userData.rangeCallback = mlRangeCallback;
        inputParameters.mlArticulation.userData.rangeCallback = mlRangeCallback;
    }

    const particleColoring = {
        "fixed": () => new THREE.Color(app_state.particleOptions.color),
        "rgb(tempo, loudness, ml)": (t, l, i) => new THREE.Color(t, l, i),
        "hsl(ml, tempo, loudness)": (t, l, i) => new THREE.Color().setHSL(i, t, l),
    }

    const app_state = {
        particleOptions: {
            position: new THREE.Vector3(),
            positionRandomness: .3,
            velocity: new THREE.Vector3(),
            velocityRandomness: .5,
            color: "#ff1493",
            particleColoring: 'rgb(tempo, loudness, ml)',
            colorRandomness: .2,
            turbulence: .5,
            lifetime: 6,
            size: 7,
            sizeRandomness: 1
        },
        particleSpawnerOptions: {
            spawnRate: 15000,
            horizontalSpeed: 1.5,
            verticalSpeed: 1.33,
            timeScale: 1,
        },
        leapMotion: {
            hand: Leap.Hand.Invalid,
            finger: Leap.Finger.Invalid,
            previousHand: Leap.Hand.Invalid,
            previousFinger: Leap.Finger.Invalid,
            boxWidth: 300,
            boxHeight: 300,
            boxDepth: 200,
            boxVerticalOffset: 250,
            clamp: true,
            get min() {
                return new THREE.Vector3(-this.boxWidth / 2.0, this.boxVerticalOffset - this.boxHeight / 2.0, -this.boxDepth / 2.0);
            },
            get max() {
                return new THREE.Vector3(this.boxWidth / 2.0, this.boxVerticalOffset + this.boxHeight / 2.0, +this.boxDepth / 2.0);
            },
            get size() {
                return new THREE.Vector3(this.boxWidth, this.boxHeight, this.boxDepth);
            },
            clampPosition: function (point) {
                return point.clone().clamp(this.min, this.max);
            },
            normalizePosition: function (point, clamp = true) {
                const result = clamp ? this.clampPosition(point) : point.clone();
                return result
                    .sub(this.min)
                    .divide(new THREE.Vector3().subVectors(this.max, this.min));
            },
            unnormalizePosition: function (point) {
                const result = point.clone().multiply(this.size()).addVector(this.min());
            }
        },
        objects: {
            curve: false,
            particles: true,
            box: false,
            label: false,
            outputParameters: false,
        },
        controls: {
            mlMIDI: true,
            mlLeapMotion: false,
            camera: false,
            composition: 0,
            play: function () {
                midiBackend.playComposition();
            },
            stop: function () {
                midiBackend.stopComposition();
            },
        },
        playback: {
            enabled: true,
        }
    }

    function createParameterModel(id, initialValue, userData) {
        return {
            id: id,
            _value: initialValue,
            _prevValue: initialValue,
            _listeners: [],
            set value(v) {
                if (this._prevValue != v) {
                    this._prevValue = this._value;
                    this._value = v;
                    for (let callback of this._listeners)
                        callback(this._value, this._prevValue, this);
                }
            },
            get value() {
                return this._value
            },
            addValueListener: function (l) {
                this._listeners.push(l);
                l(this._value);
            },
            removeValueChangeListener: function () {
                const i = this._listeners.indexOf(l);
                if (i >= 0) this._listeners = this._listeners.splice(i, 1);
            },
            userData: userData
        };
    };

    function createAnimator(initialValue, callback) {
        const ts = performance.now();
        return {
            begin: {timestamp: ts, value: initialValue},
            current: {timestamp: ts, value: initialValue},
            end: {timestamp: ts, value: initialValue},
            update: function () {
                const timestamp = performance.now();
                this.current.timestamp = Math.max(this.begin.timestamp, Math.min(timestamp, this.end.timestamp));
                const t = (this.current.timestamp - this.begin.timestamp) / (this.end.timestamp - this.begin.timestamp);
                this.current.value = this.begin.value + (this.end.value - this.begin.value) * (Number.isFinite(t) ? t : 1.0);
                callback(this.current.value, this);
            }
        }
    }

    function createParameterView(parentDomElement, parameterModel, rangeCallback, animate) {

        const label = document.createElement('div');
        label.innerText = parameterModel.id;
        label.classList.add('label', parameterModel.id);

        const marker = document.createElement('div');
        marker.classList.add('marker', parameterModel.id);

        const value = document.createElement('div');
        value.classList.add('value', parameterModel.id);
        value.appendChild(marker);

        const minValue = document.createElement('div');
        minValue.classList.add('minValue', parameterModel.id);

        const bar = document.createElement('div');
        bar.classList.add('bar', parameterModel.id);
        bar.appendChild(value);
        bar.appendChild(minValue);

        const maxDuration = animate ? 200 : 0;
        const animator = createAnimator(parameterModel.value, (v, animator) => {
            const {min, max} = rangeCallback();
            bar.style.width = `${100 * max}%`;
            minValue.style.width = `${100 * (min / max)}%`;
            value.style.width = `${100 * (min + (max - min) * v) / max}%`;
            if (parameterModel.value !== animator.end.value) {
                animator.begin.timestamp = performance.now();
                animator.begin.value = animator.current.value;
                animator.end.value = parameterModel.value;
                const duration = Math.min(maxDuration, 1000 * Math.abs(animator.end.value - animator.current.value));
                animator.end.timestamp = animator.begin.timestamp + duration;
                animator.update();
            }
        });
        parameterModel.userData.animator = animator;

        parentDomElement.appendChild(label);
        parentDomElement.appendChild(bar);

        return [label, bar];
    }

    let controller, stats;

    window.scene = null;
    window.hands = null;
    window.interactionBox = null;
    window.renderer = null;
    window.effect = null;
    window.camera = null;
    window.datgui = null;
    window.particleScope = {system: null, clock: new THREE.Clock(), tick: 0};

    let msLastPoint = -1;
    const MS_BETWEEN_POINTS = 100;
    const NUM_POINTS = 20;
    const tracePoints = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)];
    const traceGeometry = new THREE.BufferGeometry().setFromPoints(tracePoints);
    let traceCurve = null;

    function createBoxLineSegmentsGeometry() {
        const lineSegments = new THREE.Geometry();
        lineSegments.vertices.push(
            new THREE.Vector3(-1, -1, -1), new THREE.Vector3(+1, -1, -1),
            new THREE.Vector3(+1, -1, -1), new THREE.Vector3(+1, +1, -1),
            new THREE.Vector3(+1, +1, -1), new THREE.Vector3(-1, +1, -1),
            new THREE.Vector3(-1, +1, -1), new THREE.Vector3(-1, -1, -1),

            new THREE.Vector3(-1, -1, +1), new THREE.Vector3(+1, -1, +1),
            new THREE.Vector3(+1, -1, +1), new THREE.Vector3(+1, +1, +1),
            new THREE.Vector3(+1, +1, +1), new THREE.Vector3(-1, +1, +1),
            new THREE.Vector3(-1, +1, +1), new THREE.Vector3(-1, -1, +1),

            new THREE.Vector3(-1, -1, -1), new THREE.Vector3(-1, -1, +1),
            new THREE.Vector3(+1, -1, -1), new THREE.Vector3(+1, -1, +1),
            new THREE.Vector3(+1, +1, -1), new THREE.Vector3(+1, +1, +1),
            new THREE.Vector3(-1, +1, -1), new THREE.Vector3(-1, +1, +1),
        );
        lineSegments.scale(0.5, 0.5, 0.5);
        return lineSegments;
    }

    function initScene(element) {
        let axis, pointLight;
        window.scene = new THREE.Scene();
        window.renderer = new THREE.WebGLRenderer({
            alpha: true
        });
        renderer.setClearColor(0xFFFFFF, 1);
        renderer.setSize(window.innerWidth, window.innerHeight);
        element.appendChild(renderer.domElement);
        axis = new THREE.AxesHelper(40);
        scene.add(axis);
        scene.add(new THREE.AmbientLight(0x000000));
        pointLight = new THREE.PointLight(0xFFffff);
        pointLight.position.copy(new THREE.Vector3(0, 100, 1000));
        pointLight.lookAt(new THREE.Vector3(0, 200, 0));
        scene.add(pointLight);
//        window.camera = new THREE.OrthographicCamera(window.innerWidth / -5, window.innerWidth / 5, window.innerHeight / 5, window.innerHeight / -5, 1, 1000);
        window.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 1000);
        camera.position.fromArray([0, 350, 550]);
        camera.lookAt(new THREE.Vector3(0, 350, 0));
        window.controls = new THREE.OrbitControls(camera);
        window.controls.target = new THREE.Vector3(0, 350, 0);
        scene.add(camera);
        hands = new THREE.Group();
        hands.position.set(0.0, 130.0, 0.0);
        scene.add(hands);

        traceCurve = new THREE.Line(traceGeometry, new THREE.LineBasicMaterial({color: 0xff0000}));
        traceCurve.frustumCulled = false;
        hands.add(traceCurve);

        interactionBox = new THREE.LineSegments(createBoxLineSegmentsGeometry(), new THREE.LineBasicMaterial({color: 0x999999}));
        hands.add(interactionBox);

        const textureLoader = new THREE.TextureLoader();
        particleScope.system = new THREE.GPUParticleSystem({
            maxParticles: 250000,
            particleNoiseTex: textureLoader.load('../../lib/textures/perlin-512.jpg'),
            particleSpriteTex: textureLoader.load('../../lib/textures/particle2.png'),
        });
        particleScope.system.particleShaderMat.userData.outlineParameters = {visible: false};
        hands.add(particleScope.system);

        effect = new THREE.OutlineEffect(renderer);

        window.addEventListener('resize', function () {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
            if (typeof controls.handleResize === "function")
                controls.handleResize();
            return effect.render(scene, camera);
        }, false);
        return effect.render(scene, camera);
    };

    function computeInBetweenTracePoints(tracePoints) {
        const curve = new THREE.CatmullRomCurve3(tracePoints);
        const inBetweenPoints = curve.getPoints(5000);
        return inBetweenPoints;
    }

    function updateParticles(newPoint) {
        const options = Object.assign({}, app_state.particleOptions);
        const spawnerOptions = app_state.particleSpawnerOptions;
        const delta = particleScope.clock.getDelta() * spawnerOptions.timeScale;

        particleScope.tick += delta;

        if (particleScope.tick < 0) particleScope.tick = 0;

        if (app_state.leapMotion.finger.valid) {
            const spawnParticles = spawnerOptions.spawnRate * delta;
            const oldPoint = options.position;
            options.position = new THREE.Vector3();

            options.color = particleColoring[options.particleColoring](outputParameters.tempo.value, outputParameters.loudness.value, outputParameters.impact.value);
            if (app_state.leapMotion.previousFinger.valid) {
                for (var x = 0; x < spawnParticles; x++) {
                    options.position.lerpVectors(oldPoint, newPoint, x / spawnParticles);
                    particleScope.system.spawnParticle(options);
                }
            } else {
                options.position.copy(newPoint);
                for (var x = 0; x < spawnParticles; x++) {
                    particleScope.system.spawnParticle(options);
                }
            }
            app_state.particleOptions.position = options.position;
        }

        particleScope.system.update(particleScope.tick);
    }

    function animate() {
        Object.values(outputParameters).forEach(p => {
            const elements = document.getElementsByClassName(p.id);
            for (let e of elements)
                e.style.display = app_state.objects.outputParameters ? 'unset' : 'none';
            p.userData.animator.update();
        });
        Object.values(inputParameters).forEach(p => p.userData.animator.update());


        controls.enabled = app_state.controls.camera;

        interactionBox.position.addVectors(app_state.leapMotion.min, app_state.leapMotion.max).multiplyScalar(0.5);
        interactionBox.scale.subVectors(app_state.leapMotion.max, app_state.leapMotion.min);
        interactionBox.visible = app_state.objects.box;

        traceGeometry.setFromPoints(computeInBetweenTracePoints(tracePoints));
        traceGeometry.verticesNeedUpdate = true;
        traceCurve.visible = app_state.objects.curve;

        updateParticles(tracePoints[0]);
        particleScope.system.visible = app_state.objects.particles;
    }

    function render() {
        animate();
        effect.render(scene, camera);
        return controls.update();
    }

    function initOverlayScene(element) {
        const container = document.createElement('div');
        container.classList.add('parameters');

        Object.values(outputParameters).forEach(p => createParameterView(container, p, p.userData.rangeCallback, p.userData.animate));
        Object.values(inputParameters).forEach(p => createParameterView(container, p, p.userData.rangeCallback, p.userData.animate));
        element.appendChild(container);
    };

    // via Detector.js:
    let webglAvailable = (function () {
        try {
            let canvas = document.createElement('canvas');
            return !!window.WebGLRenderingContext && (canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
        } catch (e) {
            return false;
        }
    })();

    let midiBackend;
    initMidi = function () {
        console.log(WebMidi.inputs);
        console.log(WebMidi.outputs);

        // TODO: make robust aka reconnect
        const midiController = new MidiController("SOLO Control");
        midiController.addListener(value => {
            if (app_state.controls.mlMIDI)
                outputParameters.impact.value = value / 127.0;
        });

        midiBackend = new MidiBackendProxy({maxScaleFactor: 2.0});
        const mlKeyMap = {
            'loudness': 'mlLoudness',
            'dynamicSpread': 'mlDynamicSpread',
            'tempo': 'mlTempo',
            'microTiming': 'mlMicroTiming',
            'articulation': 'mlArticulation',
        };
        midiBackend.addParameterListener((key, value) => inputParameters[mlKeyMap[key]].value = value);
        midiBackend.addMusicListener({
            'noteOn': (number, velocity) => midiPlayer.noteOn(0, number, velocity),
            'noteOff': (number) => midiPlayer.noteOff(0, number),
            'hold': (enable) => midiPlayer.hold = enable,
        });
        outputParameters.tempo.addValueListener(l => midiBackend.tempo = l);
        outputParameters.loudness.addValueListener(l => midiBackend.loudness = l);
        outputParameters.impact.addValueListener(l => midiBackend.impact = l);

        // stop playing and play from the beginning
        midiBackend.stopComposition();
        midiBackend.playComposition();
    };

    function initDatGui() {
        datgui = new dat.GUI({width: 400});

        const particleFolder = datgui.addFolder('particles');

        particleFolder.add(app_state.particleOptions, "velocityRandomness", 0, 3);
        particleFolder.add(app_state.particleOptions, "positionRandomness", 0, 3);
        particleFolder.add(app_state.particleOptions, "size", 1, 20);
        particleFolder.add(app_state.particleOptions, "sizeRandomness", 0, 25);
        particleFolder.add(app_state.particleOptions, "particleColoring", Object.keys(particleColoring));
        particleFolder.addColor(app_state.particleOptions, "color");
        particleFolder.add(app_state.particleOptions, "colorRandomness", 0, 1);
        particleFolder.add(app_state.particleOptions, "lifetime", .1, 10);
        particleFolder.add(app_state.particleOptions, "turbulence", 0, 1);

        particleFolder.add(app_state.particleSpawnerOptions, "spawnRate", 10, 30000);
        particleFolder.add(app_state.particleSpawnerOptions, "timeScale", -1, 1);

        const leapMotionFolder = datgui.addFolder('leap motion');

        leapMotionFolder.add(app_state.leapMotion, "boxWidth", 0, 1000);
        leapMotionFolder.add(app_state.leapMotion, "boxHeight", 0, 1000);
        leapMotionFolder.add(app_state.leapMotion, "boxDepth", 0, 1000);
        leapMotionFolder.add(app_state.leapMotion, "boxVerticalOffset", 0, 1000);
        leapMotionFolder.add(app_state.leapMotion, "clamp");

        const objectsFolder = datgui.addFolder('objects');

        objectsFolder.add(app_state.objects, "curve");
        objectsFolder.add(app_state.objects, "particles");
        objectsFolder.add(app_state.objects, "box");
        objectsFolder.add(app_state.objects, "label");
        objectsFolder.add(app_state.objects, "outputParameters");

        const controlsFolder = datgui.addFolder('controls');
        controlsFolder.open();

        const compositions = {
            "0: beethoven_op027_no2_mv1_bm_z": 0,
            "1: chopin_op10_No3_bm_magaloff": 1,
            "2: mozart_k331_3_batik": 2,
            "3: beethoven_fuer_elise": 3,
        };

        controlsFolder.add(app_state.controls, "mlMIDI");
        controlsFolder.add(app_state.controls, "mlLeapMotion");
        controlsFolder.add(app_state.controls, "camera");
        const compositionSelector = controlsFolder.add(app_state.controls, "composition", compositions);
        compositionSelector.onChange(() => {
            midiBackend.selectComposition(app_state.controls.composition);
        });
        const playButton = controlsFolder.add(app_state.controls, "play");
        const stopButton = controlsFolder.add(app_state.controls, "stop");
        controlsFolder.add(outputParameters.impact, "value", 0.0, 1.0).name("machine learning").listen();
        controlsFolder.add(outputParameters.loudness, "value", 0.0, 1.0).name("loudness").listen();
        controlsFolder.add(outputParameters.tempo, "value", 0.0, 1.0).name("tempo").listen();

        const optionsFolder = datgui.addFolder('options');

        const useMIDIJS = optionsFolder.add(app_state.playback, "enabled");
        useMIDIJS.onChange(() => midiPlayer.muted = !app_state.playback.enabled);
    }

    let midiPlayer;
    if (webglAvailable) {
        initScene(document.body);
        initOverlayScene(document.body);
        initDatGui();

        midiPlayer = new MidiPlayer();
        WebMidi.enable(function (err) {
            if (err) {
                console.log("WebMidi could not be enabled.", err);
            } else {
                console.log("WebMidi enabled!");
                initMidi();
            }
        });
    }

    stats = new Stats();
    stats.domElement.id = 'stats';
    document.body.appendChild(stats.domElement);

    let prevHand = Leap.Hand.Invalid;
    let prevFinger = Leap.Finger.Invalid;

    function updatePosition(frame) {
        app_state.leapMotion.previousHand = app_state.leapMotion.hand;
        app_state.leapMotion.previousFinger = app_state.leapMotion.finger;

        app_state.leapMotion.hand = frame.hand(prevHand.id);
        app_state.leapMotion.finger = Leap.Finger.Invalid;
        for (let i = 0; i < frame.hands.length && !app_state.leapMotion.hand.valid; ++i) {
            app_state.leapMotion.hand = frame.hands[i];
        }
        if (app_state.leapMotion.hand.valid) {
            if (app_state.leapMotion.hand.fingers.length > 0) {
                const preference = ['indexFinger', 'middleFinger', 'thumb', 'ringFinger', 'pinky'];
                for (let fingerName of preference) {
                    if (app_state.leapMotion.hand[fingerName].valid) {
                        app_state.leapMotion.finger = app_state.leapMotion.hand[fingerName];
                        break;
                    }
                }
                if (app_state.leapMotion.finger.valid) {
                    const tipPosition = new THREE.Vector3().fromArray(app_state.leapMotion.finger.tipPosition);
                    tipPosition.addScaledVector(new THREE.Vector3().fromArray(app_state.leapMotion.finger.direction), app_state.leapMotion.finger.length / 5.0);
                    if (app_state.leapMotion.clamp)
                        tipPosition.copy(app_state.leapMotion.clampPosition(tipPosition));
                    const normalizedTipPosition = app_state.leapMotion.normalizePosition(tipPosition);
                    outputParameters.tempo.value = normalizedTipPosition.x;
                    outputParameters.loudness.value = normalizedTipPosition.y;
                    if (app_state.controls.mlLeapMotion)
                        outputParameters.impact.value = 1.0 - normalizedTipPosition.z;
                    const msCurrentPoint = frame.timestamp / 1000;
                    const currentPoint = tipPosition.clone();
                    if (msLastPoint + MS_BETWEEN_POINTS <= msCurrentPoint) {
                        tracePoints.unshift(currentPoint);
                        msLastPoint = msCurrentPoint;
                    } else {
                        tracePoints[0].lerp(currentPoint, 0.5);
                    }
                    while (tracePoints.length > NUM_POINTS)
                        tracePoints.pop();
                }
            }
        }
    }

    window.controller = controller = new Leap.Controller({
        background: true,
        loopWhileDisconnected: true
    });

    controller.on('frame', updatePosition);

    window.riggedHandScope = {
        parent: hands,
        renderer: renderer,
        scale: 1.0,
        positionScale: 1.0,
        helper: false,
        offset: new THREE.Vector3(0, 0, 0),
        renderFn: null /* dummy value, otherwise init fails */,
        materialOptions: {
            wireframe: false,
            transparent: false,
            opacity: 0.1,
            transparent: true,
            color: new THREE.Color('#FFFFFF'),
            userData: {
                outlineParameters: {
                    visible: true,
                    alpha: 0.5,
                    thickness: 0.015,
                    color: [0, 0, 0],
                }
            },
        },
        dotsMode: false,
        stats: stats,
        camera: camera,
        boneLabels: function (boneMesh, leapHand) {
            const fingerName = `Finger_${app_state.leapMotion.finger.type}3`;
            if (app_state.objects.label && boneMesh.name === fingerName && leapHand.id == app_state.leapMotion.hand.id) {
                return ['tempo', 'loudness', 'impact']
                    .map(a => `${a}: ${(outputParameters[a].value).toFixed(2)}`).join(', ');
            }
        },
        boneColors: function (boneMesh, leapHand) {
            const fingerNamePrefix = `Finger_${app_state.leapMotion.finger.type}`;
            if ((boneMesh.name.indexOf(fingerNamePrefix) === 0) && leapHand.id == app_state.leapMotion.hand.id) {
                return {
                    hue: 0.0,
                    lightness: 0.5,
                    saturation: (1 + parseInt(boneMesh.name.substring(boneMesh.name.length - 1))) / 4
                };
            }
        },
        checkWebGL: true
    };

    controller
        .use('handHold')
        .use('transform', {})
        .use('handEntry')
        .use('screenPosition')
        .use('riggedHand', riggedHandScope)
        .on('frameEnd', render)
        .connect();
}).call(this);

/*
// on screen positioning might be useful later:
window.sphere = new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshBasicMaterial(0x0000ff));
scene.add(sphere);
controller.on('frame', function (frame) {
    var hand, handMesh, screenPosition;
    if (hand = frame.hands[0]) {
        handMesh = frame.hands[0].data('riggedHand.mesh');
        screenPosition = handMesh.screenPosition(hand.fingers[1].tipPosition, camera);
        cursor.style.left = screenPosition.x;
        return cursor.style.bottom = screenPosition.y;
    }
    if (hand = frame.hands[0]) {
        handMesh = frame.hands[0].data('riggedHand.mesh');
        return handMesh.scenePosition(hand.indexFinger.tipPosition, sphere.position);
    }
});
*/
