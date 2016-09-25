
Ext.define('CustomApp', {
    extend: 'Rally.app.TimeboxScopedApp',
    getSettingsFields: function() {
		return [
			{
				name: 'onlyshowaccepted',
				xtype: 'rallycheckboxfield',
				fieldLabel: '',
				boxLabel: 'Only show accepted work items.'
			},
			{
				name: 'plannedgoal',
				xtype: 'rallynumberfield',
				fieldLabel: 'Planned Work Goal %'
			},
			{
				name: 'cvgoal',
				xtype: 'rallynumberfield',
				fieldLabel: 'Customer Voice Work Goal %'
			},
			{
				name: 'unplannedgoal',
				xtype: 'rallynumberfield',
				fieldLabel: 'Unplanned Work Goal %'
			}
		];
	},
	config: {
        defaultSettings: {
            onlyshowaccepted: false,
            plannedgoal: 65,
            cvgoal: 10,
            unplannedgoal: 25
        }
    },
    scopeType: 'release',
    pagesize: 200,
    
    onScopeChange: function(newTimeboxScope) {
		this.callParent( arguments );
		this.fetchIterations( newTimeboxScope );
	},
    
    fetchIterations:function( timeboxScope ){
		// Delete any existing UI components
		if( this.down( 'rallychart' ) ) {
			this.down( 'rallychart' ).destroy();
        }
        if( this.down( 'label' ) ) {
			this.down( 'label' ).destroy();
        }    
    
        // Show loading message
        this._myMask = new Ext.LoadMask(Ext.getBody(), {msg:"Calculating...Please wait."});
        this._myMask.show();
        
        // Look for iterations that are within the release
        this.filters = [];
        var startDate = timeboxScope.record.raw.ReleaseStartDate;
        var endDate = timeboxScope.record.raw.ReleaseDate;
        var startDateFilter = Ext.create('Rally.data.wsapi.Filter', {
             property : 'StartDate',
             operator: '>=',
             value: startDate
        });
        
        var endDateFilter = Ext.create('Rally.data.wsapi.Filter', {
             property : 'StartDate',
             operator: '<',
             value: endDate
        });
        
        this.filters.push( startDateFilter );
        this.filters.push( endDateFilter );

		var dataScope = this.getContext().getDataContext();
		var store = Ext.create(
			'Rally.data.wsapi.Store',
			{
				model: 'Iteration',
				fetch: ['ObjectID','Name','StartDate','EndDate','PlanEstimate'],
				context: dataScope,
				pageSize: this.pagesize,
				limit:this.pagesize,
				sorters:[{
					property:'StartDate',
					direction: 'ASC'
				}]
			},
			this
        );

        this.iterations = [];
        store.addFilter(this.filters,false);
        store.loadPage(1, {
            scope: this,
            callback: function(records, operation) {
                if(operation.wasSuccessful()) {
                    if (records.length > 0) {
                        _.each(records, function(record){
							// Only put in unique iteration names to support higher-level project graphs
							var iterationName = record.get('Name');
							if( this.iterations.indexOf( iterationName ) == -1 ) {
								this.iterations.push( iterationName );
                            }
                        },this);
						this.fetchWorkItems();
                    }
                    else if(records.length === 0 && this.iterations.length === 0){
                        this.showNoDataBox();   
                    }
                }
            }
        });
    },

    fetchWorkItems:function(){
        this.artifactStore = Ext.create(
			'Rally.data.wsapi.artifact.Store',
			{
				models: ['Defect', 'DefectSuite', 'UserStory'],
				fetch: ['ObjectID','Name','FormattedID','PlanEstimate','Iteration','Tags','Feature'],
				limit: Infinity
			},
			this
        );
        
        this.iterationFilters = [];
        _.each(this.iterations, function(iteration)
			{
				var iterationNameFilter = Ext.create('Rally.data.wsapi.Filter',
					{
						property: 'Iteration.Name',
						value: iteration
					}
				);				
				this.iterationFilters.push(iterationNameFilter);
			},
			this
        );
        
        var numOfIterations = this.iterationFilters.length;
        this.artifacts = new Array(numOfIterations);
        for (var i = 0; i < numOfIterations; i++) {
            this.artifacts[i] = [];
        }
       
        this.applyIterationFiltersToArtifactStore(0);
    },
    
    applyIterationFiltersToArtifactStore:function(i){
		this.artifactStore.addFilter(this.iterationFilters[i], false);
		
		// Check if the settings say we should only look at accepted work items
		var onlyShowAccepted = this.getSetting( 'onlyshowaccepted' );
		if ( onlyShowAccepted ) {
			var acceptedFilter = Ext.create('Rally.data.wsapi.Filter',
				{
					property: 'ScheduleState',
					operator: '>=',
					value: 'Accepted'
				}
			);				
			this.artifactStore.addFilter(acceptedFilter, false);
		}
		
        this.artifactStore.load({
            scope: this,
            callback: function(records, operation) {
                if(operation.wasSuccessful()) {
                    _.each(records, function(record){
                        this.artifacts[i].push({
                            '_ref':record.get('_ref'),   
                            'FormattedID':record.get('FormattedID'),
                            'Name':record.get('Name'),
                            'PlanEstimate':record.get('PlanEstimate'),
                            'IterationName': record.get('Iteration')._refObjectName,
                            'IterationRef' : record.get('Iteration')._ref,
                            'Tags' : record.get('Tags'),
                            'Feature' : record.get('Feature')
                        });
                    },this);
                    this.artifactStore.clearFilter();
                    
                    //if not done, call itself for the next iteration
                    if (i < this.iterationFilters.length-1) { 
                        this.applyIterationFiltersToArtifactStore(i + 1);
                    }
                    else{
                        this.prepareChart();
                    }
                }
            }
        });
    },
    
    prepareChart:function(){
        if (this.artifacts.length > 0) {
            var series = [];
            var categories = [];
            var portfolioData = [];
            var cvDefectsData = [];
            var unplannedData = [];
            var portfolioGoalData = [];
            var cvDefectsGoalData = [];
            var unplannedGoalData = [];
            var releaseTotalPoints = 0;
            var releaseTotalPlannedPoints = 0;
            var releaseTotalCvDefectsPoints = 0;
            var releaseTotalUnplannedPoints = 0;
            
            var portfolioGoal = this.getSetting( 'plannedgoal' );
            var cvGoal = this.getSetting( 'cvgoal' );
            var unplannedGoal = this.getSetting( 'unplannedgoal' );

            this.artifacts = _.filter(this.artifacts,function(artifactsPerIterationName){
                return artifactsPerIterationName.length !== 0;
            });

            _.each(this.artifacts, function(artifactsPerIterationName){
                var portfolioPoints = 0;
                var cvDefectsPoints = 0;
                var unplannedPoints = 0;
                var totalPoints = 0;
                var data = [];
                
                var name = artifactsPerIterationName[0].IterationName;
                categories.push(name);
                
                _.each(artifactsPerIterationName, function(artifact){
					if ( artifact.Feature ) {
						portfolioPoints += artifact.PlanEstimate;
					} else if ( _.find( artifact.Tags._tagsNameArray, function( tag ) { return tag.Name == 'Customer Voice'; } ) ) {
						cvDefectsPoints += artifact.PlanEstimate;
                    } else {
						unplannedPoints += artifact.PlanEstimate;
                    }
                    
                    totalPoints += artifact.PlanEstimate;

                },this);
                
                portfolioData.push( ( ( portfolioPoints / totalPoints ) * 100 ) );
                cvDefectsData.push( ( ( cvDefectsPoints / totalPoints ) * 100 ) );
                unplannedData.push( ( ( unplannedPoints / totalPoints ) * 100 ) );
                
                portfolioGoalData.push( portfolioGoal );
                cvDefectsGoalData.push( cvGoal );
                unplannedGoalData.push( unplannedGoal );
                
                releaseTotalPoints += totalPoints;
                releaseTotalPlannedPoints += portfolioPoints;
                releaseTotalCvDefectsPoints += cvDefectsPoints;
                releaseTotalUnplannedPoints += unplannedPoints;
            },this);
            
            // Add a category for the Release Total
            categories.push( 'Total' );
            portfolioData.push( ( ( releaseTotalPlannedPoints / releaseTotalPoints ) * 100 ) );
            cvDefectsData.push( ( ( releaseTotalCvDefectsPoints / releaseTotalPoints ) * 100 ) );
            unplannedData.push( ( ( releaseTotalUnplannedPoints / releaseTotalPoints ) * 100 ) );
            portfolioGoalData.push( portfolioGoal );
            cvDefectsGoalData.push( cvGoal );
            unplannedGoalData.push( unplannedGoal );
            
            series.push({
                name : 'Portfolio',
                data : portfolioData,
                type : 'column'
            });
            series.push({
                name : 'CV Defects',
                data : cvDefectsData,
                type : 'column'
            });
            series.push({
                name : 'Unplanned',
                data : unplannedData,
                type : 'column'
            });
            series.push({
                name : 'Portfolio Goal',
                data : portfolioGoalData,
                type : 'line',
                lineWidth : 2,
                marker: {
					enabled: false
                }
            });
            series.push({
                name : 'CV Defects Goal',
                data : cvDefectsGoalData,
                type : 'line',
                lineWidth : 2,
                marker: {
					enabled: false
                }
            });
            series.push({
                name : 'Unplanned Goal',
                data : unplannedGoalData,
                type : 'line',
                lineWidth : 2,
                marker: {
					enabled: false
                }
            });
            
            this.makeChart( series, categories );
        }
        else{
            this.showNoDataBox();
        }    
    },
    
    makeChart:function(series, categories){
        var chart = this.add({
            xtype: 'rallychart',
            chartConfig: {
                chart:{
                    type: 'column',
                    zoomType: 'xy'
                },
                title:{
                    text: 'Work Distribution Chart'
                },
                xAxis: {
                    title: {
                        text: 'Iterations'
                    }
                },
                yAxis:{
                    title: {
                        text: 'Plan Estimates'
                    },
                    allowDecimals: false,
                    min : 0,
                    max : 100
                },
                plotOptions: {
                    column: {
                        pointPadding: 0.2,
                        borderWidth: 0
                    }
                }
            },
                            
            chartData: {
                series: series,
                categories: categories
            }
          
        });
        
        // Workaround bug in setting colors - http://stackoverflow.com/questions/18361920/setting-colors-for-rally-chart-with-2-0rc1/18362186
        chart.setChartColors( [ '#005EB8', '#FF8200', '#FAD200', '#7CAFD7', '#F6A900', '#FFDD82' ] );
        
        this._myMask.hide();
    },
    
    showNoDataBox:function(){
        this._myMask.hide();
		this.add({
			xtype: 'label',
			text: 'There is no data. Check if there are iterations in scope and work items with PlanEstimate assigned for iterations'
        });
    }
});